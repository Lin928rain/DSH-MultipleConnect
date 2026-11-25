import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectStore, DEFAULT_CONNECTION_SETTINGS } from '../plugin-src/host/connect-store.mjs';
import { createMultipleConnect, MainConversation } from '../plugin-src/host/multiple-connect.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { captureExternal } from '../src/channels/shared/multiple-connect.mjs';
import { createImSendToolDefinition } from '../src/channels/shared/im-send-tool.mjs';
import { normalizeSnowlumaMessage, SnowlumaSocket } from '../plugin-src/host/snowluma.mjs';

const sample = (id) => ({
  messageId: String(id), conversationId: 'chat-1', senderId: 'user-1',
  text: `private content ${id}`,
});
const configured = (values) => ({ ...DEFAULT_CONNECTION_SETTINGS, ...values });

function hostFixture() {
  let sequence = 0;
  const archived = new Set();
  const initialized = [];
  return {
    archived,
    initialized,
    host: {
      workspace: async () => ({ workspaceId: 'workspace' }),
      available: ({ sessionId }) => !archived.has(sessionId),
      create: async () => `session-${++sequence}`,
      initialize: async (sessionId) => { initialized.push(sessionId); },
    },
  };
}

test('external inbox and message threshold survive restart and duplicate delivery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'multiple-connect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'connections.sqlite');
  let store = new ConnectStore(database);
  assert.deepEqual(store.settings('bot'), DEFAULT_CONNECTION_SETTINGS);
  store.receive('bot', sample(0));
  store.configure('bot', configured({ autoNotify: true, threshold: 5 }));
  assert.equal(store.receive('bot', sample(1)), 'external');
  assert.equal(store.receive('bot', sample(2)), 'external');
  store.close();

  store = new ConnectStore(database);
  try {
    assert.equal(store.receive('bot', sample(2)), 'external');
    assert.equal(store.receive('bot', sample(3)), 'external');
    assert.equal(store.receive('bot', sample(4)), 'external');
    assert.equal(store.nextNotification(), undefined);
    assert.equal(store.readMessages('bot', 'chat-1', Number.MAX_SAFE_INTEGER, 1)[0].text, sample(4).text);
    assert.equal(store.receive('bot', sample(5)), 'notify');
    assert.equal(store.nextNotification().count, 5);
    assert.equal(store.listConversations('bot', Number.MAX_SAFE_INTEGER, 20)[0].messageCount, 6);
    store.configure('bot', configured({ mode: 'internal' }));
    assert.equal(store.receive('bot', sample(6)), 'internal');
    assert.equal(store.nextNotification(), undefined);
    assert.equal(store.listConversations('bot', Number.MAX_SAFE_INTEGER, 20)[0].messageCount, 6);
  } finally { store.close(); }
});

test('one current main is initialized once and automatically replaced after archive', async () => {
  const store = new ConnectStore(':memory:');
  try {
    const { host, archived, initialized } = hostFixture();
    const main = new MainConversation(store, host);
    const created = await Promise.all([main.ensure(), main.ensure(), main.ensure()]);
    assert.deepEqual(created.map(({ sessionId }) => sessionId), ['session-1', 'session-1', 'session-1']);
    archived.add('session-1');
    assert.equal(main.current(), undefined);
    const second = await main.ensure();
    assert.equal(second.sessionId, 'session-2');
    archived.delete('session-1');
    assert.deepEqual(await main.ensure(), second);
    assert.deepEqual(initialized, ['session-1', 'session-2']);
  } finally { store.close(); }
});

test('two internal chats retain their own delivery and a queued turn follows main archival', async () => {
  const store = new ConnectStore(':memory:');
  const { host, archived } = hostFixture();
  const main = new MainConversation(store, host);
  store.configure('bot', configured({ mode: 'internal' }));
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const output = [];
  const harness = {
    ask: async (id, text, { onUpdate }) => {
      if (text === 'from channel A') {
        started();
        await pause;
      }
      await onUpdate({ text });
      return `${id}: ${text}`;
    },
  };
  const connection = { main, harness, mode: () => store.settings('bot').mode, receive: (message) => store.receive('bot', message) };
  const ask = (text) => askInWorkspaceSession({
    harness: { multipleConnect: connection }, text,
    askOptions: { onUpdate: (update) => output.push([text, update.text]) },
  });
  try {
    assert.equal(captureExternal({ multipleConnect: connection }, sample(1)), false);
    const first = ask('from channel A');
    const second = ask('from channel B');
    await firstStarted;
    archived.add('session-1');
    release();
    assert.equal((await first).answer, '');
    assert.equal((await second).answer, 'session-2: from channel B');
    assert.deepEqual(output, [['from channel B', 'from channel B']]);
  } finally { store.close(); }
});

test('external notifications contain only source and count', async () => {
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const notices = [];
  host.notify = async (entry, requestId, text) => notices.push({ entry, requestId, text });
  const runtime = createMultipleConnect({}, {}, { listBots: async () => [{ botId: 'bot', channel: 'qq' }] }, { store, host });
  try {
    store.configure('bot', configured({ autoNotify: true, threshold: 2 }));
    const connection = runtime.connection('bot');
    assert.equal(connection.receive(sample(1)), 'external');
    assert.equal(connection.receive(sample(2)), 'notify');
    await runtime.kick();
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /qq.+bot.+2/u);
    assert.doesNotMatch(notices[0].text, /private content/u);
    assert.equal(store.nextNotification(), undefined);
  } finally { await runtime.close(); }
});

test('tool permission is rechecked at delivery and tool requires an explicit target', async () => {
  const service = createDeliveryService();
  const saved = { targetId: 'target' };
  const sent = [];
  let permitted = true;
  service.registerAdapter({
    channel: 'qq', ownsBot: () => true, listBots: () => ['bot'],
    listTargets: async () => {
      await Promise.resolve();
      permitted = false;
      return [saved];
    },
    listSuggestions: () => [], createTarget() {}, updateTarget() {}, deleteTarget() {},
    sendText: (...args) => sent.push(args),
  });
  const tool = createImSendToolDefinition({
    send: (bot, target, text, options) => service.send(bot, target, text, { ...options, authorize: () => permitted }),
  });
  await assert.rejects(tool.execute({ text: 'test' }), /botId, targetId/u);
  await assert.rejects(tool.execute({ botId: 'bot', targetId: 'target', text: 'test' }), /tool-send-disabled/u);
  assert.equal(sent.length, 0);
});

test('Snowluma separates private/group, filters self echo and checks group mention', () => {
  const config = { users: ['20'], groups: ['30'] };
  const event = { post_type: 'message', message_type: 'private', user_id: 20, self_id: 10, message_id: -5,
    message: [{ type: 'text', data: { text: 'hello' } }] };
  assert.equal(normalizeSnowlumaMessage(event, config).conversationId, '10:private:20');
  assert.equal(normalizeSnowlumaMessage({ ...event, user_id: 10 }, config), null);
  const group = { ...event, message_type: 'group', group_id: 30 };
  assert.equal(normalizeSnowlumaMessage(group, config).addressed, false);
  assert.equal(normalizeSnowlumaMessage({
    ...group, message: [{ type: 'at', data: { qq: '10' } }, ...event.message],
  }, config).addressed, true);
});

test('Snowluma transport uses authenticated OneBot frames and associates responses', async () => {
  class FakeSocket extends EventTarget {
    static current;
    readyState = 1;
    constructor(url, options) { super(); Object.assign(this, { url, options }); FakeSocket.current = this; }
    send(text) { this.request = JSON.parse(text); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const received = [];
  const socket = new SnowlumaSocket({ url: 'ws://localhost:3001', token: 'secret' }, (event) => received.push(event), { Socket: FakeSocket });
  try {
    const wire = FakeSocket.current;
    assert.equal(wire.options.headers.Authorization, 'Bearer secret');
    const promise = socket.request('send_group_msg', { group_id: 30 });
    assert.equal(wire.request.action, 'send_group_msg');
    wire.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: wire.request.echo, status: 'ok', retcode: 0, data: { message_id: 7 } }) }));
    assert.deepEqual(await promise, { message_id: 7 });
    wire.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ post_type: 'message' }) }));
    await Promise.resolve();
    assert.deepEqual(received, [{ post_type: 'message' }]);
  } finally { socket.close(); }
});
