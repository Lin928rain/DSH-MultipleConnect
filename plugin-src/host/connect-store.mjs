import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_CONNECTION_SETTINGS = Object.freeze({
  mode: 'external',
  toolSend: false,
  autoNotify: false,
  threshold: 1,
});

export function validateConnectionSettings(value) {
  if (!value || !['internal', 'external'].includes(value.mode)
    || typeof value.toolSend !== 'boolean' || typeof value.autoNotify !== 'boolean'
    || !Number.isSafeInteger(value.threshold) || value.threshold < 1) {
    throw new TypeError('Invalid connection settings');
  }
  return {
    mode: value.mode,
    toolSend: value.toolSend,
    autoNotify: value.autoNotify,
    threshold: value.threshold,
  };
}

export class ConnectStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (
        bot_id TEXT PRIMARY KEY, value TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL, kind TEXT NOT NULL, sender_id TEXT NOT NULL,
        text TEXT NOT NULL, attachments TEXT NOT NULL, received_at INTEGER NOT NULL,
        UNIQUE (bot_id, conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS inbox_page ON messages (bot_id, conversation_id, id);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, count INTEGER NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  getState(key) {
    const result = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return result ? JSON.parse(result.value) : undefined;
  }

  setState(key, value) {
    this.db.prepare(`INSERT INTO state VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  settings(botId) {
    const result = this.db.prepare('SELECT value FROM settings WHERE bot_id = ?').get(botId);
    return result ? JSON.parse(result.value) : DEFAULT_CONNECTION_SETTINGS;
  }

  configure(botId, value) {
    const settings = validateConnectionSettings(value);
    return this.transaction(() => {
      const before = this.settings(botId);
      const reset = before.mode !== settings.mode || before.autoNotify !== settings.autoNotify;
      this.db.prepare(`INSERT INTO settings VALUES (?, ?, 0)
        ON CONFLICT (bot_id) DO UPDATE SET value = excluded.value,
        pending = CASE WHEN ? THEN 0 ELSE pending END`).run(botId, JSON.stringify(settings), Number(reset));
      if (settings.mode === 'internal' || !settings.autoNotify) {
        this.db.prepare('DELETE FROM notifications WHERE bot_id = ?').run(botId);
      }
      return settings;
    });
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  receive(botId, message) {
    return this.transaction(() => {
      const settings = this.settings(botId);
      if (settings.mode === 'internal') return 'internal';
      const { messageId, conversationId, kind = 'direct', senderId, text = '', attachments = [], receivedAt } = message;
      if (!messageId || !conversationId || !senderId) return 'external';
      const { changes } = this.db.prepare(`INSERT INTO messages
        (bot_id, conversation_id, message_id, kind, sender_id, text, attachments, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
        botId, String(conversationId), String(messageId), kind, String(senderId),
        typeof text === 'string' ? text : '', JSON.stringify(attachments),
        Number.isSafeInteger(receivedAt) ? receivedAt : Date.now(),
      );
      if (!changes || !settings.autoNotify) return 'external';
      const { pending } = this.db.prepare(
        'UPDATE settings SET pending = pending + 1 WHERE bot_id = ? RETURNING pending',
      ).get(botId);
      if (pending < settings.threshold) return 'external';
      this.db.prepare('INSERT INTO notifications (bot_id, count) VALUES (?, ?)').run(botId, pending);
      this.db.prepare('UPDATE settings SET pending = 0 WHERE bot_id = ?').run(botId);
      return 'notify';
    });
  }

  nextNotification() {
    return this.db.prepare('SELECT id, bot_id AS botId, count FROM notifications ORDER BY id LIMIT 1').get();
  }

  finishNotification(id) {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  }

  listConversations(botId, before, limit) {
    return this.db.prepare(`SELECT conversation_id AS conversationId, kind,
        count(*) AS messageCount, max(id) AS cursor, max(received_at) AS lastReceivedAt
      FROM messages WHERE bot_id = ? GROUP BY conversation_id
      HAVING max(id) < ? ORDER BY cursor DESC LIMIT ?`).all(botId, before, limit);
  }

  readMessages(botId, conversationId, before, limit) {
    return this.db.prepare(`SELECT id AS cursor, message_id AS messageId,
        sender_id AS senderId, text, attachments, received_at AS receivedAt
      FROM messages WHERE bot_id = ? AND conversation_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?`).all(botId, conversationId, before, limit)
      .map((item) => ({ ...item, attachments: JSON.parse(item.attachments) }));
  }
}
