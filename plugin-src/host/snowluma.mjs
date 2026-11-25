import { deliverOutboundArtifacts } from '../../src/channels/shared/semantic/artifact-delivery.mjs';
import { releaseOutboundArtifact } from '../../src/channels/shared/semantic/artifact.mjs';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'undici';
import { HarnessClient } from '../../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../../src/channels/shared/workspace-session.mjs';
import { createMessageBreakHandler } from '../../src/channels/shared/message-break.mjs';
import { splitMessageText } from '../../src/channels/shared/editable-message-stream.mjs';
import { harnessConnection } from './harness-connection.mjs';
import { normalizeDeliveryTarget } from './delivery-adapter.mjs';

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function wireId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value ?? '');
  return /^-?\d{1,16}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : '';
}

function allowList(value) {
  if (!Array.isArray(value) || value.some((id) => !wireId(id) || Number(id) <= 0)) {
    throw new TypeError('Allowed QQ users and groups must be lists of positive IDs');
  }
  return [...new Set(value.map(String))];
}

export function normalizeSnowlumaMessage(event, { users, groups, accountId }) {
  if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  const group = event.message_type === 'group';
  const senderId = wireId(event.user_id);
  const selfId = wireId(event.self_id);
  if (!senderId || !selfId || selfId === senderId || accountId && accountId !== selfId) return null;
  const chatId = group ? wireId(event.group_id) : senderId;
  if (!chatId || !(group ? groups : users).includes(chatId)) return null;
  if (!group && event.sub_type === 'group') return null;
  const messageId = wireId(event.message_id);
  if (!messageId) return null;
  const segments = Array.isArray(event.message) ? event.message.filter((item) => item && typeof item === 'object')
    : [{ type: 'text', data: { text: event.raw_message ?? event.message } }];
  const addressed = !group || segments.some(({ type, data }) => type === 'at' && wireId(data?.qq) === selfId);
  const text = segments.map(({ type, data }) => {
    if (type === 'text') return typeof data?.text === 'string' ? data.text : '';
    if (type === 'at') return wireId(data?.qq) === selfId ? '' : `@${wireId(data?.qq) || 'all'}`;
    if (type === 'reply') return wireId(data?.id) ? `[Reply to QQ message ${wireId(data.id)}]` : '';
    return `[${typeof type === 'string' ? type : 'attachment'}]`;
  }).join('').trim();
  if (!text) return null;
  return {
    messageId, senderId, chatId, selfId, kind: group ? 'group' : 'direct',
    conversationId: `${selfId}:${group ? 'group' : 'private'}:${chatId}`,
    text, addressed,
    attachments: segments.filter(({ type }) => !['text', 'at', 'reply'].includes(type))
      .map(({ type, data }) => ({ type, ...(typeof data?.file === 'string' ? { name: data.file } : {}) })),
    receivedAt: Number.isSafeInteger(event.time) ? event.time * 1000 : undefined,
  };
}

export class SnowlumaSocket {
  #socket;
  #timer;
  #pending = new Map();
  #closed = false;

  constructor(config, onMessage, { Socket = WebSocket, onError = () => {} } = {}) {
    this.config = config;
    this.onMessage = onMessage;
    this.Socket = Socket;
    this.onError = onError;
    this.connect();
  }

  get connected() { return this.#socket?.readyState === 1; }

  connect() {
    if (this.#closed) return;
    let socket;
    try {
      const headers = this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {};
      socket = new this.Socket(this.config.url, { headers });
    } catch {
      this.retry();
      return;
    }
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      if (this.#closed || socket !== this.#socket || typeof data !== 'string') return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (typeof event.echo === 'string') {
        const finish = this.#pending.get(event.echo);
        if (finish) finish(event.status === 'ok' && event.retcode === 0 ? undefined : failure('target-rejected'), event.data);
        return;
      }
      void Promise.resolve().then(() => this.onMessage(event)).catch(this.onError);
    });
    socket.addEventListener('error', () => {
      // The close event owns reconnection and failure of outstanding requests.
    });
    socket.addEventListener('close', () => {
      if (socket !== this.#socket) return;
      for (const finish of this.#pending.values()) finish(failure('send-result-unknown'));
      this.retry();
    }, { once: true });
  }

  retry() {
    if (this.#closed) return;
    this.#timer = setTimeout(() => this.connect(), 5_000);
    this.#timer.unref?.();
  }

  request(action, params, signal) {
    signal?.throwIfAborted();
    if (!this.connected) return Promise.reject(failure('bot-not-connected'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, data) => {
        this.#pending.delete(echo);
        signal?.removeEventListener('abort', cancel);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(data);
      };
      const cancel = () => finish(signal.reason);
      const timer = setTimeout(() => finish(failure('send-result-unknown')), 15_000);
      timer.unref?.();
      this.#pending.set(echo, finish);
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.#socket.send(JSON.stringify({ action, params, echo })); }
      catch (error) { finish(error); }
    });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const finish of this.#pending.values()) finish(failure('cancelled'));
    this.#socket?.close();
  }
}

function validateConfig(value, previous) {
  const botId = value.botId ?? `snowluma-${randomUUID()}`;
  if (!/^snowluma-[a-z0-9-]{1,100}$/.test(botId)) throw new TypeError('Invalid Snowluma connection ID');
  const url = new URL(value.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new TypeError('Use a ws:// or wss:// endpoint and enter the token separately');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) {
    throw new TypeError('Enter a name for this Snowluma connection');
  }
  const token = value.token ?? previous?.token ?? '';
  if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new TypeError('Invalid access token');
  return {
    botId, name: value.name.trim(), url: url.href, token,
    users: allowList(value.users), groups: allowList(value.groups),
    accountId: previous?.url === url.href && previous?.token === token ? previous?.accountId : undefined,
  };
}

function messageParams(kind, id) {
  if (!wireId(id) || Number(id) <= 0) throw failure('invalid-target');
  return { [kind === 'group' ? 'group_id' : 'user_id']: Number(id) };
}

function sendSegments(socket, kind, id, message, signal) {
  return socket.request(kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
    ...messageParams(kind, id), message,
  }, signal);
}

function transmit(socket, kind, id, text, { signal, replyId } = {}) {
  const segments = replyId ? [{ type: 'reply', data: { id: replyId } }] : [];
  segments.push({ type: 'text', data: { text } });
  return sendSegments(socket, kind, id, segments, signal);
}

function inlineAttachment(file) {
  if (file.size > 8 * 1024 * 1024) throw failure('target-rejected', 'The OneBot attachment exceeds 8 MiB');
  return 'base64://' + Buffer.from(file.bytes).toString('base64');
}

export function createSnowlumaManager({ ctx, config, runtime, deliveryService, logger, Socket }) {
  const entries = new Map();
  const closeSignal = new AbortController();
  const store = runtime.store;
  const stored = () => store.getState('snowluma.connections') ?? [];
  const saved = (botId) => store.getState(`snowluma.targets:${botId}`) ?? [];
  const persist = (botId, targets) => store.setState(`snowluma.targets:${botId}`, targets);
  let harness;
  const getHarness = () => (harness ??= new HarnessClient(harnessConnection(ctx, config)));
  const sending = new Set();
  const seen = new Map();

  function mount(account) {
    entries.get(account.botId)?.socket.close();
    const bridge = runtime.connection(account.botId, { ask: (...args) => getHarness().ask(...args) });
    const controller = new AbortController();
    const socket = new SnowlumaSocket(account, async (event) => {
      if (controller.signal.aborted) return;
      const message = normalizeSnowlumaMessage(event, account);
      if (!message) return;
      if (!account.accountId) {
        account.accountId = message.selfId;
        store.setState('snowluma.connections', stored().map((item) => item.botId === account.botId ? account : item));
      }
      if (bridge.receive(message) !== 'internal' || !message.addressed) return;
      const key = `${account.botId}:${message.conversationId}:${message.messageId}`;
      if (seen.has(key)) return;
      seen.set(key, true);
      if (seen.size > 2048) seen.delete(seen.keys().next().value);
      const signal = AbortSignal.any([closeSignal.signal, controller.signal]);
      const kind = message.kind === 'group' ? 'group' : 'user';
      const send = async (body, replyId) => {
        for (const text of splitMessageText(body, 1800)) {
          await transmit(socket, kind, message.chatId, text, { signal, replyId });
          replyId = undefined;
        }
      };
      let sentSegments = 0;
      const breaks = createMessageBreakHandler({
        sendSegment: (text) => send(text, sentSegments++ === 0 ? message.messageId : undefined),
        logger,
      });
      const task = askInWorkspaceSession({
        harness: { multipleConnect: bridge },
        text: `[Snowluma · ${kind} ${message.chatId} · sender ${message.senderId}]\n${message.text}`,
        askOptions: {
          signal,
          progressMode: 'all',
          onUpdate: (update) => breaks.handleUpdate(update),
        },
      }).then(async ({ answer, artifacts }) => {
        try {
          const remainder = breaks.remainingText(answer ?? '');
          if (remainder.trim()) await send(remainder, sentSegments === 0 ? message.messageId : undefined);
        } catch (error) {
          for (const artifact of artifacts ?? []) releaseOutboundArtifact(artifact);
          throw error;
        }
        if (artifacts?.length) await deliverOutboundArtifacts({
          artifacts, channelKey: 'snowluma', deliveryId: message.messageId, signal, logger,
          sendImage: (file) => sendSegments(socket, kind, message.chatId, [{
            type: 'image', data: { file: inlineAttachment(file) },
          }], signal),
          sendFile: (file) => socket.request(kind === 'group' ? 'upload_group_file' : 'upload_private_file', {
            ...messageParams(kind, message.chatId), file: inlineAttachment(file), name: file.fileName,
          }, signal),
          sendFailureNotice: () => send('Unable to deliver an attachment.'),
        });
      });
      sending.add(task);
      try { await task; } finally { sending.delete(task); }
    }, { Socket, onError: (error) => logger.warn?.('[dsh-multiple-connect] Snowluma inbound:', error?.code ?? error?.message) });
    entries.set(account.botId, { account, socket, controller });
  }

  function unmount(botId) {
    const entry = entries.get(botId);
    entry?.controller.abort();
    entry?.socket.close();
    entries.delete(botId);
  }

  for (const entry of stored()) mount(entry);
  const unregister = deliveryService.registerAdapter({
    channel: 'snowluma',
    ownsBot: (botId) => entries.has(botId),
    listBots: () => [...entries.keys()],
    listTargets: saved,
    listSuggestions: (botId) => {
      const { account } = entries.get(botId);
      return [
        ...account.users.map((chatId) => ({ name: `QQ ${chatId}`, kind: 'user', route: { chatId } })),
        ...account.groups.map((chatId) => ({ name: `QQ群 ${chatId}`, kind: 'group', route: { chatId } })),
      ];
    },
    createTarget(botId, target) {
      const targets = saved(botId);
      if (targets.some(({ targetId }) => targetId === target.targetId)) throw failure('target-conflict');
      const value = normalizeDeliveryTarget('snowluma', target);
      persist(botId, [...targets, value]);
      return value;
    },
    updateTarget(botId, targetId, target) {
      const targets = saved(botId);
      if (!targets.some((item) => item.targetId === targetId)) throw failure('unknown-target');
      const value = normalizeDeliveryTarget('snowluma', { ...target, targetId });
      persist(botId, targets.map((item) => item.targetId === targetId ? value : item));
      return value;
    },
    deleteTarget(botId, targetId) {
      const targets = saved(botId);
      persist(botId, targets.filter((item) => item.targetId !== targetId));
      return { deleted: targets.some((item) => item.targetId === targetId) };
    },
    async sendText(botId, target, body, options) {
      const entry = entries.get(botId);
      if (!entry) throw failure('unknown-bot');
      for (const text of splitMessageText(body, 1800)) {
        await transmit(entry.socket, target.kind, target.route.chatId, text, options);
      }
    },
  });
  return {
    list: () => [...entries.values()].map(({ account: { token, ...value }, socket }) => ({
      ...value, hasToken: Boolean(token), connected: socket.connected,
    })),
    configure(value) {
      const existing = entries.get(value.botId)?.account;
      if (value.botId && !existing) throw failure('unknown-bot');
      const next = validateConfig(value, existing);
      store.setState('snowluma.connections', [...stored().filter((item) => item.botId !== next.botId), next]);
      unmount(next.botId);
      mount(next);
      return { botId: next.botId };
    },
    remove(botId) {
      if (!entries.has(botId)) throw failure('unknown-bot');
      store.setState('snowluma.connections', stored().filter((item) => item.botId !== botId));
      unmount(botId);
      return { deleted: true };
    },
    async close() {
      closeSignal.abort();
      for (const botId of entries.keys()) unmount(botId);
      unregister();
      await Promise.allSettled(sending);
      harness?.stopManagedProcess();
    },
  };
}
