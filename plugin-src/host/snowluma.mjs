import { deliverOutboundArtifacts } from '../../src/channels/shared/semantic/artifact-delivery.mjs';
import { releaseOutboundArtifact } from '../../src/channels/shared/semantic/artifact.mjs';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'undici';
import { HarnessClient } from '../../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../../src/channels/shared/workspace-session.mjs';
import { BusyMessageDispatcher } from '../../src/channels/shared/busy-message-dispatcher.mjs';
import { normalizeBusyMessageMode, storedBusyMessageMode, validateBusyMessageMode } from '../../src/channels/shared/message-mode.mjs';
import { createMessageBreakHandler } from '../../src/channels/shared/message-break.mjs';
import { splitMessageText } from '../../src/channels/shared/editable-message-stream.mjs';
import { harnessConnection } from './harness-connection.mjs';
import { createHarnessSessionExecutors } from './harness-session-coordinator.mjs';
import { normalizeDeliveryTarget } from './delivery-adapter.mjs';
import { inboxPrompt } from '../../src/channels/shared/multiple-connect.mjs';
import { createOneBotInboxProvider, oneBotContent, oneBotSegments, oneBotWireId as wireId } from './onebot-inbox.mjs';

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function allowList(value) {
  if (!Array.isArray(value) || value.some((id) => !wireId(id) || Number(id) <= 0)) {
    throw new TypeError('Allowed QQ users and groups must be lists of positive IDs');
  }
  return [...new Set(value.map(String))];
}

export function normalizeSnowlumaMessage(event, { users, groups, accountId }) {
  const deleted = event?.post_type === 'notice' && ['group_recall', 'friend_recall'].includes(event.notice_type);
  const upload = event?.post_type === 'notice' && event.notice_type === 'group_upload' && typeof event.file?.id === 'string';
  if (!deleted && !upload && (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type))) return null;
  const group = event.message_type === 'group' || event.notice_type === 'group_recall' || upload;
  const senderId = wireId(event.user_id);
  const selfId = wireId(event.self_id);
  if (!senderId || !selfId || selfId === senderId || accountId && accountId !== selfId) return null;
  const chatId = group ? wireId(event.group_id) : senderId;
  if (!chatId || !(group ? groups : users).includes(chatId)) return null;
  if (!group && event.sub_type === 'group') return null;
  const messageId = upload ? 'upload:' + event.file.id : wireId(event.message_id);
  if (!messageId) return null;
  const segments = upload ? [{ type: 'file', data: event.file }] : oneBotSegments(event.message ?? event.raw_message);
  const addressed = !group || segments.some(({ type, data }) => type === 'at' && wireId(data?.qq) === selfId);
  const content = oneBotContent(segments, { route: { kind: group ? 'group' : 'private', chatId, selfId }, messageId, selfId });
  if (!content.text && !deleted && !addressed) return null;
  return {
    messageId, senderId, chatId, selfId, kind: group ? 'group' : 'direct',
    conversationId: `${selfId}:${group ? 'group' : 'private'}:${chatId}`,
    ...content, addressed, ...(deleted ? { deleted: true } : {}), ...(upload ? { passive: true } : {}),
    receivedAt: Number.isSafeInteger(event.time) ? event.time * 1000 : undefined,
  };
}

export class SnowlumaSocket {
  #socket;
  #timer;
  #pending = new Map();
  #closed = false;

  constructor(config, onMessage, { Socket = WebSocket, onError = () => {}, onOpen } = {}) {
    this.config = config;
    this.onMessage = onMessage;
    this.Socket = Socket;
    this.onError = onError;
    this.onOpen = onOpen;
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
    if (this.onOpen) socket.addEventListener('open', () => {
      if (!this.#closed && socket === this.#socket) void Promise.resolve().then(this.onOpen).catch(() => undefined);
    }, { once: true });
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
    busyMessageMode: value.busyMessageMode === undefined ? storedBusyMessageMode(previous?.busyMessageMode)
      : value.busyMessageMode === null ? undefined : validateBusyMessageMode(value.busyMessageMode),
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

export function createSnowlumaManager({ ctx, config, runtime, deliveryService, logger, Socket, Harness = HarnessClient }) {
  const entries = new Map();
  const closeSignal = new AbortController();
  const store = runtime.store;
  const stored = () => store.getState('snowluma.connections') ?? [];
  const saved = (botId) => store.getState(`snowluma.targets:${botId}`) ?? [];
  const persist = (botId, targets) => store.setState(`snowluma.targets:${botId}`, targets);
  let harness, transport;
  function getHarness() {
    if (harness) return harness;
    transport = harnessConnection(ctx, { ...config, multipleConnectRuntime: runtime });
    const { controlExecutor } = createHarnessSessionExecutors(ctx);
    harness = new Harness({
      ...transport,
      // Only the same-process executor can verify the exact prompt and pending interaction.
      controlExecutor: (request) => !transport.apiProxy.hasPendingInteraction(request.sessionId)
        && controlExecutor?.(request) === true,
    });
    return harness;
  }
  const sending = new Set();

  function mount(account) {
    const bridge = runtime.connection(account.botId, { ask: (...args) => getHarness().ask(...args) });
    const controller = new AbortController();
    const dispatcher = new BusyMessageDispatcher();
    const owner = {};
    const status = {};
    const acceptedMessageIds = new Set();
    const report = (error) => {
      if (!controller.signal.aborted && error?.code !== 'turn-stopped') {
        logger.warn?.('[dsh-multiple-connect] Snowluma inbound:', error?.code ?? error?.message);
      }
    };
    const sessionFor = (key) => bridge.activeTurns.get(key);
    const state = { sessionFor, hasSeen: () => false, markSeen: () => undefined };
    const controls = {
      workspaceSession: (sessionId) => ({
        steerActiveTurn: (...args) => getHarness().steerActiveTurn(sessionId, ...args),
        stopActiveTurn: (...args) => getHarness().stopActiveTurn(sessionId, ...args),
      }),
    };
    const rememberAccount = (accountId) => {
      if (!accountId || account.accountId || controller.signal.aborted) return;
      account.accountId = accountId;
      store.setState('snowluma.connections', stored().map((item) => item.botId === account.botId ? account : item));
    };
    const socket = new SnowlumaSocket(account, async (event) => {
      if (controller.signal.aborted) return;
      const message = normalizeSnowlumaMessage(event, account);
      if (!message) return;
      rememberAccount(message.selfId);
      if (bridge.receive(message) !== 'internal' || !message.addressed || !message.text) return;
      const key = message.conversationId;
      const messageId = JSON.stringify([key, message.messageId]);
      const signal = AbortSignal.any([closeSignal.signal, controller.signal]);
      const kind = message.kind === 'group' ? 'group' : 'user';
      const control = { owner, key };
      const text = `[Snowluma · ${kind} ${message.chatId} · sender ${message.senderId}]\n${message.text}\n${inboxPrompt(message, account.botId)}`;
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
      const enqueue = () => askInWorkspaceSession({
        harness: { multipleConnect: bridge },
        key,
        text,
        askOptions: {
          signal,
          control,
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
      }).catch(report);
      const task = dispatcher.dispatch({
        key, messageId, text, commandText: message.text, eligible: true,
        mode: account.busyMessageMode ?? normalizeBusyMessageMode(config.humanizeDefaults?.('snowluma')?.busyMessageMode),
        harness: controls, state, status, control, signal, acceptedMessageIds, enqueue, send, logger,
        isQueued: () => Boolean(sessionFor(key)),
        pendingInteraction: () => transport?.apiProxy.hasPendingInteraction(sessionFor(key)) ?? false,
        quietQueue: true, onError: report,
      });
      sending.add(task);
      try { await task; } finally { sending.delete(task); }
    }, { Socket, onError: report,
      async onOpen() {
        if (account.accountId) return;
        const identity = await socket.request('get_login_info', {}, controller.signal);
        rememberAccount(wireId(identity?.user_id));
      },
    });
    const unbind = bridge.bindInboxProvider?.(createOneBotInboxProvider(account, socket, controller.signal));
    if (unbind) controller.signal.addEventListener('abort', unbind, { once: true });
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
      if (existing && existing.url === next.url && existing.token === next.token
        && existing.users.length === next.users.length && existing.users.every((id) => next.users.includes(id))
        && existing.groups.length === next.groups.length && existing.groups.every((id) => next.groups.includes(id))) {
        Object.assign(existing, next);
        return { botId: next.botId };
      }
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
