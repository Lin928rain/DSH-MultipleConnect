import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

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
    this.path = path;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
    }
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
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS inbox_resources (
        message_row INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL, value TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (message_row, resource_id)
      );
      CREATE TABLE IF NOT EXISTS inbox_recalls (
        bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS inbox_conversation_resources (
        bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        value TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, conversation_id, resource_id)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(({ name }) => name === 'details')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS inbox_received_at ON messages (received_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS inbox_native_message ON messages (bot_id, message_id)');
  }

  close() { this.db.close(); }

  size() {
    if (this.path === ':memory:') return 0;
    return [this.path, this.path + '-wal', this.path + '-shm']
      .reduce((bytes, file) => bytes + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
  }

  relocate(destination, commit) {
    if (destination === this.path) return commit();
    if ([destination, destination + '-wal', destination + '-shm'].some(existsSync)) {
      throw new Error('The destination already contains a message database.');
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = destination + '.' + randomUUID();
    let next;
    let transferred = false;
    try {
      this.db.prepare('VACUUM INTO ?').run(temporary);
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      try {
        if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') {
          throw new Error('Message database integrity check failed.');
        }
      } finally { snapshot.close(); }
      renameSync(temporary, destination);
      transferred = true;
      next = new ConnectStore(destination);
      const result = commit();
      this.db.close();
      this.db = next.db;
      this.path = destination;
      return result;
    } catch (error) {
      next?.close();
      if (transferred) for (const suffix of ['', '-wal', '-shm']) rmSync(destination + suffix, { force: true });
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

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
      const { messageId, conversationId, kind = 'direct', senderId, text = '', attachments = [],
        receivedAt, updatedAt, deleted, passive, ...details } = message;
      if (!messageId || !conversationId || !senderId) return settings.mode;
      const identifiers = [botId, String(conversationId), String(messageId)];
      const recalled = details.chatId && this.db.prepare(`SELECT 1 FROM inbox_recalls
        WHERE bot_id = ? AND chat_id = ? AND message_id = ?`).get(botId, details.chatId, String(messageId));
      if (recalled && !deleted) return 'silent';
      if (deleted || Number.isSafeInteger(updatedAt)) {
        const current = this.message(botId, String(conversationId), String(messageId));
        if (current?.details?.deleted || (current?.details?.updatedAt ?? -1) >= (updatedAt ?? Infinity)) return 'silent';
        const revision = { ...details, ...(updatedAt ? { updatedAt } : {}), ...(deleted ? { deleted: true } : {}) };
        if (current) {
          this.db.prepare(`UPDATE messages SET text = ?, attachments = ?, details = ?
            WHERE bot_id = ? AND conversation_id = ? AND message_id = ?`).run(
            deleted ? '' : text, JSON.stringify(deleted ? [] : attachments), JSON.stringify(revision), ...identifiers,
          );
          this.db.prepare('DELETE FROM inbox_resources WHERE message_row = ?').run(current.cursor);
          return 'silent';
        }
      }
      const { changes } = this.db.prepare(`INSERT INTO messages
        (bot_id, conversation_id, message_id, kind, sender_id, text, attachments, received_at, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
        ...identifiers, kind, String(senderId),
        !deleted && typeof text === 'string' ? text : '', JSON.stringify(deleted ? [] : attachments),
        Number.isSafeInteger(receivedAt) ? receivedAt : Date.now(),
        JSON.stringify(deleted ? { deleted: true } : { ...details, ...(updatedAt ? { updatedAt } : {}) }),
      );
      if (deleted || passive || Number.isSafeInteger(updatedAt)) return 'silent';
      if (settings.mode === 'internal') return changes ? 'internal' : 'silent';
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
        sender_id AS senderId, text, attachments, received_at AS receivedAt, details
      FROM messages WHERE bot_id = ? AND conversation_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?`).all(botId, conversationId, before, limit)
      .map(decodeMessage);
  }

  message(botId, conversationId, messageId) {
    return decodeMessage(this.db.prepare(`SELECT id AS cursor, message_id AS messageId,
      sender_id AS senderId, text, attachments, received_at AS receivedAt, details
      FROM messages WHERE bot_id = ? AND conversation_id = ? AND message_id = ?`).get(botId, conversationId, messageId));
  }

  album(botId, conversationId, albumId, before, limit) {
    return this.db.prepare(`SELECT id AS cursor, message_id AS messageId, sender_id AS senderId, text,
      attachments, received_at AS receivedAt, details FROM messages WHERE bot_id = ? AND conversation_id = ?
      AND id < ? AND json_extract(details, '$.albumId') = ? ORDER BY id DESC LIMIT ?`)
      .all(botId, conversationId, before, albumId, limit).map(decodeMessage);
  }

  pruneMessages(olderThan) {
    this.db.prepare('DELETE FROM inbox_resources WHERE received_at < ?').run(Date.now() - 30 * 86_400_000);
    this.db.prepare('DELETE FROM inbox_recalls WHERE received_at < ?').run(Date.now() - 30 * 86_400_000);
    this.db.prepare('DELETE FROM inbox_conversation_resources WHERE received_at < ?').run(Date.now() - 30 * 86_400_000);
    this.db.prepare('DELETE FROM messages WHERE received_at < ?').run(olderThan);
  }

  recall(botId, messageId, chatId) {
    this.db.prepare('INSERT OR IGNORE INTO inbox_recalls VALUES (?, ?, ?, ?)').run(botId, chatId, messageId, Date.now());
    const rows = this.db.prepare(`SELECT conversation_id, sender_id FROM messages
      WHERE bot_id = ? AND message_id = ? AND json_extract(details, '$.chatId') = ?`).all(botId, messageId, chatId);
    for (const row of rows) this.receive(botId, { messageId, conversationId: row.conversation_id, senderId: row.sender_id, deleted: true });
  }

  putResource(message, id, value) {
    this.db.prepare(`INSERT INTO inbox_resources VALUES (?, ?, ?, ?)
      ON CONFLICT (message_row, resource_id) DO UPDATE SET value = excluded.value, received_at = excluded.received_at`)
      .run(message.cursor, id, JSON.stringify(value), Date.now());
  }

  resource(message, id) {
    const item = this.db.prepare('SELECT value FROM inbox_resources WHERE message_row = ? AND resource_id = ?')
      .get(message.cursor, id);
    return item ? JSON.parse(item.value) : undefined;
  }

  putConversationResource(botId, conversationId, id, value) {
    this.db.prepare(`INSERT INTO inbox_conversation_resources VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (bot_id, conversation_id, resource_id) DO UPDATE SET value = excluded.value, received_at = excluded.received_at`)
      .run(botId, conversationId, id, JSON.stringify(value), Date.now());
  }

  conversationResource(botId, conversationId, id) {
    const item = this.db.prepare(`SELECT value FROM inbox_conversation_resources
      WHERE bot_id = ? AND conversation_id = ? AND resource_id = ?`).get(botId, conversationId, id);
    return item ? JSON.parse(item.value) : undefined;
  }
}

function decodeMessage(item) {
  return item && { ...item, attachments: JSON.parse(item.attachments), details: JSON.parse(item.details) };
}
