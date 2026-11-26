import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';
import { ConnectStore, DEFAULT_CONNECTION_SETTINGS } from '../plugin-src/host/connect-store.mjs';
import { createDshMainHost, createMultipleConnect, installConnectRpc, MainConversation } from '../plugin-src/host/multiple-connect.mjs';
import { MultipleConnectSettings, SnowlumaSettings } from '../plugin-src/client/multiple-connect-settings.js';
import { WorkspaceDirectoryPickerContext } from '../plugin-src/client/workspace-editor.js';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryRpcHandler } from '../plugin-src/host/delivery-rpc.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { captureExternal } from '../src/channels/shared/multiple-connect.mjs';
import { createImSendToolDefinition } from '../src/channels/shared/im-send-tool.mjs';
import { createSnowlumaManager, normalizeSnowlumaMessage, SnowlumaSocket } from '../plugin-src/host/snowluma.mjs';
import { installInboxTools } from '../plugin-src/host/inbox-tools.mjs';
import { createOneBotInboxProvider } from '../plugin-src/host/onebot-inbox.mjs';
import { feishuInboxContent } from '../src/channels/feishu/message-utils.mjs';
import { createFeishuInboxProvider } from '../src/channels/feishu/inbox-provider.mjs';
import { qqInboxRecord } from '../src/channels/qq/qq-bridge.mjs';
import { weixinInboxContent } from '../src/channels/weixin/weixin-api.mjs';
import { normalizeTelegramUpdate } from '../src/channels/telegram/telegram-runtime.mjs';

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
    assert.equal(store.listConversations('bot', Number.MAX_SAFE_INTEGER, 20)[0].messageCount, 7);
  } finally { store.close(); }
});

test('chat overrides and inherited notification cycles are isolated by chat and connection', () => {
  const store = new ConnectStore(':memory:');
  const inbound = (id, conversationId, extra = {}) => ({ ...sample(id), conversationId, ...extra });
  try {
    store.configure('bot', configured({ autoNotify: true, threshold: 2 }));
    store.configure('other', configured({ mode: 'internal' }));
    assert.equal(store.receive('bot', inbound(1, 'alpha')), 'external');
    assert.equal(store.receive('bot', inbound(1, 'beta')), 'external');
    assert.equal(store.receive('other', inbound(1, 'alpha')), 'internal');
    assert.equal(store.nextNotification(), undefined);
    store.configureChat('bot', 'alpha', { mode: 'internal', autoNotify: false, threshold: 1 });
    assert.equal(store.receive('bot', inbound(1, 'alpha')), 'silent');
    assert.equal(store.receive('bot', inbound(2, 'alpha')), 'internal');
    assert.equal(store.receive('bot', inbound(2, 'beta')), 'notify');
    store.configureChat('bot', 'alpha', { mode: 'external', autoNotify: true, threshold: 3 });
    assert.equal(store.nextNotification().chatId, 'beta');
    assert.equal(store.receive('bot', inbound(3, 'alpha')), 'external');
    store.configure('bot', configured({ mode: 'internal', autoNotify: false }));
    assert.equal(store.nextNotification(), undefined);
    assert.equal(store.receive('bot', inbound(1, 'new')), 'internal');
    assert.equal(store.receive('bot', inbound(4, 'alpha')), 'external');
    assert.equal(store.receive('bot', inbound(5, 'alpha')), 'notify');
    store.configureChat('bot', 'alpha', null);
    assert.equal(store.nextNotification(), undefined);
    assert.equal(store.receive('bot', inbound(6, 'alpha')), 'internal');
  } finally { store.close(); }
});

test('the delivery picker includes bot-local inbox chats without independent DSH sessions', async () => {
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const service = createDeliveryService();
  const runtime = createMultipleConnect({}, {}, service, { store, host });
  const options = (botIds, sessions) => ({
    workspaces: { has: (id) => botIds.includes(id), listBotIds: () => botIds, listDeliveryTargets: () => [] },
    coreController: {},
    stateFor: () => ({ snapshot: () => ({ sessions }) }),
  });
  service.registerAdapter(createDeliveryAdapter({ channel: 'feishu', ...options(['lark', 'other_lark'], {}) }));
  service.registerAdapter(createDeliveryAdapter({ channel: 'telegram', ...options(['tg'], { 'group:-100:42': 'old-session' }) }));
  const rpc = createDeliveryRpcHandler(service);
  try {
    store.configure('lark', configured({ mode: 'internal' }));
    runtime.connection('lark').receive({ ...sample(1), conversationId: 'p2p:ou_self' });
    runtime.connection('lark').receive({ ...sample(2), conversationId: 'group:oc_team:thread:omt_thread', kind: 'group' });
    runtime.connection('lark').receive({ ...sample(3), conversationId: 'group:oc_team:managed:om_root', kind: 'group' });
    runtime.connection('other_lark').receive({ ...sample(1), conversationId: 'p2p:ou_other' });
    runtime.connection('tg').receive({ ...sample(1), conversationId: '-100:42', kind: 'group' });
    runtime.connection('tg').receive({ ...sample(2), conversationId: '781', kind: 'direct' });

    const result = await rpc('target.suggestion.list', { botId: 'lark' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.suggestions, [
      { kind: 'group', route: { chatId: 'oc_team' } },
      { kind: 'user', route: { openId: 'ou_self' } },
    ]);
    assert.deepEqual((await service.listSuggestions('tg')).suggestions, [
      { kind: 'topic', route: { chatId: '-100', messageThreadId: 42 } },
      { kind: 'chat', route: { chatId: '781' } },
    ]);
    assert.deepEqual((await service.listTargets('lark')).targets, []);
    await assert.rejects(service.send('lark', 'ou_self', 'hello'), { code: 'unknown-target' });
  } finally { await runtime.close(); }
});

test('main wake uses one permitted internal DM, with an optional fixed recipient and no fallback from it', async () => {
  const store = new ConnectStore(':memory:');
  const { host, archived } = hostFixture();
  const service = createDeliveryService();
  const sent = [];
  const allowed = new Set(['ou_one', 'ou_two']);
  const runtime = createMultipleConnect({}, {}, service, { store, host, logger: { warn() {} } });
  let blockBeforeSend;
  const botIds = ['feishu-1', 'feishu-2'];
  service.registerAdapter(createDeliveryAdapter({
    channel: 'feishu',
    workspaces: {
      has: async (id) => {
        if (blockBeforeSend) await blockBeforeSend();
        return botIds.includes(id);
      },
      listBotIds: () => botIds,
      listDeliveryTargets: () => [],
    },
    stateFor: () => ({ snapshot: () => ({ sessions: {} }) }),
    coreController: { sendProactiveText: (botId, target, text) => sent.push({ botId, route: target.route, text }) },
  }));
  const lark1 = runtime.connection(botIds[0]);
  const lark2 = runtime.connection(botIds[1]);
  for (const lark of [lark1, lark2]) {
    lark.bindInboxProvider({ allowsWakeRecipient: (id) => allowed.has(id) });
  }
  const dm = (id, person, extra = {}) => ({
    ...sample(id), senderId: person, conversationId: 'p2p:' + person, ...extra,
  });
  try {
    const { sessionId } = await runtime.main.ensure();
    store.configure(botIds[0], configured({ mode: 'internal' }));
    lark1.receive(dm(1, 'ou_one', { routeId: 'oc_one', chatName: 'First chat' }));
    lark1.receive(dm(2, 'ou_three', { routeId: 'oc_blocked' }));
    lark1.receive({ ...sample(3), conversationId: 'group:oc_group', kind: 'group' });
    lark2.receive(dm(1, 'ou_two', { routeId: 'oc_two' }));
    assert.equal(await runtime.wakeDelivery.send('other-session', 'do not relay'), undefined);
    assert.equal(await runtime.wakeDelivery.send(sessionId, 'Wake reply'), 'IM delivered (feishu)');
    assert.deepEqual(sent, [{ botId: botIds[0], route: { openId: 'ou_one' }, text: 'Wake reply' }]);

    store.configure(botIds[1], configured({ mode: 'internal' }));
    assert.match(await runtime.wakeDelivery.send(sessionId, 'Ambiguous'), /choose one internal private chat/);
    assert.equal(sent.length, 1);
    const { choices } = await runtime.wakeDelivery.status();
    assert.deepEqual(choices.map(({ botId, chatId, name }) => [botId, chatId, name]), [
      [botIds[0], 'oc_one', 'First chat'], [botIds[1], 'oc_two', null],
    ]);
    await runtime.wakeDelivery.configure({ mode: 'pinned', id: choices[1].id });
    store.pruneMessages(Date.now() + 10_000);
    assert.equal(await runtime.wakeDelivery.send(sessionId, 'Pinned wake reply'), 'IM delivered (feishu)');
    assert.equal(sent.at(-1).botId, botIds[1]);
    assert.equal((await runtime.wakeDelivery.status()).choices[0].id, choices[1].id);

    // Even a route changed while the send awaits adapter resolution must not receive the reply.
    blockBeforeSend = async () => {
      blockBeforeSend = undefined;
      store.configureChat(botIds[1], 'oc_two', { mode: 'external', autoNotify: true, threshold: 1 });
    };
    assert.match(await runtime.wakeDelivery.send(sessionId, 'Blocked on recheck'), /IM delivery failed/);
    assert.match(await runtime.wakeDelivery.send(sessionId, 'Unavailable'), /selected chat is unavailable/);
    assert.equal(sent.length, 2);

    await runtime.wakeDelivery.configure({ mode: 'disabled' });
    assert.equal(await runtime.wakeDelivery.send(sessionId, 'Disabled'), 'IM delivery disabled');
    archived.add(sessionId);
    const replacement = await runtime.main.ensure();
    assert.equal(await runtime.wakeDelivery.send(sessionId, 'Old main'), undefined);
    assert.equal(await runtime.wakeDelivery.send(replacement.sessionId, 'Disabled after replacement'), 'IM delivery disabled');
  } finally { await runtime.close(); }
});

test('legacy chats are discovered at upgrade and Telegram topics inherit the group configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'multiple-connect-chat-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'connections.sqlite');
  const topic = { ...sample(1), conversationId: '-100:97', threadId: '97', kind: 'group' };
  let store = new ConnectStore(database);
  store.configure('tg', configured({ mode: 'internal' }));
  store.receive('tg', topic);
  store.receive('fs', { ...sample(1), conversationId: 'group:oc_test:topic:1', chatId: 'oc_test', kind: 'group' });
  store.close();
  const legacy = new DatabaseSync(database);
  legacy.exec("DROP TABLE chat_routes; DELETE FROM state WHERE key = 'chat_routes_initialized';");
  legacy.close();
  store = new ConnectStore(database);
  try {
    assert.deepEqual(store.chats('tg', Infinity, 30).map(({ chatId }) => chatId).sort(), ['-100', '-100:97']);
    assert.equal(store.chats('fs', Infinity, 30)[0].chatId, 'oc_test');
    assert.equal(store.listConversations('fs', Infinity, 30, 'oc_test')[0].conversationId, 'group:oc_test:topic:1');
    assert.equal(store.chatSettings('tg', topic.conversationId).mode, 'internal');
    store.configureChat('tg', '-100', { mode: 'external', autoNotify: true, threshold: 2 });
    assert.equal(store.receive('tg', { ...topic, messageId: '2', parentRouteId: '-100' }), 'external');
    assert.equal(store.receive('tg', { ...topic, messageId: '3', parentRouteId: '-100' }), 'notify');
    assert.equal(store.nextNotification().chatId, topic.conversationId);
  } finally { store.close(); }
  store = new ConnectStore(database);
  try {
    assert.equal(store.chatSettings('tg', topic.conversationId).mode, 'external');
    assert.equal(store.nextNotification().count, 2);
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

test('one click registers the default folder and retries an incomplete main without duplicates', async (t) => {
  const documentsDirectory = await mkdtemp(join(tmpdir(), 'multiple-connect-documents-'));
  t.after(() => rm(documentsDirectory, { recursive: true, force: true }));
  const store = new ConnectStore(':memory:');
  t.after(() => store.close());
  const path = join(documentsDirectory, 'deepseek-harness', 'default-workspace');
  const workspace = { id: 'registered-default', sessionIds: [] };
  const workspaces = new Map([['project', { id: 'project', sessionIds: [] }]]);
  let registrations = 0;
  let creations = 0;
  let renameAttempts = 0;
  let route;
  const ctx = {
    connection: { fetch: { register(value) { route = value; } } },
    workspaceRegistry: { get: (id) => workspaces.get(id), archivedSessionIds: [] },
    workspaceController: {
      config: { documentsDirectory },
      initializeDefault: async () => undefined,
      create: async (input) => {
        registrations += 1;
        assert.deepEqual(input, { path });
        assert.ok((await stat(path)).isDirectory());
        workspaces.set(workspace.id, workspace);
        return { workspace: { workspaceId: workspace.id } };
      },
    },
    sessionController: {
      create: async ({ workspaceId }) => {
        assert.equal(workspaceId, workspace.id);
        const sessionId = `created-${++creations}`;
        workspace.sessionIds.push(sessionId);
        return { sessionId };
      },
      rename: async () => { if (++renameAttempts === 1) throw new Error('retry rename'); },
    },
    agents: { get: () => ({ session: {} }) },
    permissionPresets: { set: (_session, preset) => assert.equal(preset, 'danger-full-access') },
  };
  const main = new MainConversation(store, createDshMainHost(ctx));
  installConnectRpc(ctx, { main }, {}, {}, {});

  const rpc = async (method, payload = {}) => {
    const endpoint = 'dsh-im/dsh-multiple-connect';
    const response = await route.fetch(new Request('http://127.0.0.1/api/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'setup', method: endpoint, payload: { method, payload } }),
    }));
    return (await response.json()).result;
  };
  assert.equal(await main.ensure(), undefined);
  assert.equal(registrations, 0);
  const first = await rpc('main.setup-default', { path: documentsDirectory });
  assert.equal(first.error.message, 'retry rename');
  const [recovered, duplicate, competing] = await Promise.all([
    rpc('main.setup-default'), rpc('main.setup-default'), rpc('workspace.set', { workspaceId: 'project' }),
  ]);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered, duplicate);
  assert.equal(competing.ok, false);
  assert.equal(recovered.value.workspaceId, workspace.id);
  assert.equal(store.getState('workspace'), workspace.id);
  assert.equal(registrations, 2);
  assert.equal(workspaces.size, 2);
  assert.equal(creations, 1);
});

test('main conversation settings can create a main in the default workspace with one click', async (t) => {
  const { act, create } = TestRenderer;
  const calls = [];
  const status = { workspaces: [{ workspaceId: 'project', title: 'Project' }], bots: [] };
  async function rpc(method, payload) {
    calls.push({ method, payload });
    if (method === 'status') return { ok: true, value: { ...status } };
    assert.equal(method, 'main.setup-default');
    status.main = { sessionId: 'new-main' };
    return { ok: true, value: status.main };
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(MultipleConnectSettings, { rpc })); });
  t.after(() => act(() => renderer.unmount()));
  const buttons = () => renderer.root.findAllByType('button');
  await act(async () => buttons().find(({ children }) => children.includes('使用默认工作区创建主对话')).props.onClick());
  assert.deepEqual(calls.map(({ method }) => method), ['status', 'main.setup-default', 'status']);
  assert.ok(buttons().some(({ children }) => children.includes('打开主对话')));
});

test('main conversation settings save a selected wake recipient', async (t) => {
  const { act, create } = TestRenderer;
  const recipient = { id: 'private-choice', channel: 'feishu', botId: 'lark', conversationId: 'p2p:ou_self' };
  let saved;
  async function rpc(method, payload) {
    if (method === 'status') return { ok: true, value: { main: { sessionId: 'main' }, bots: [] } };
    if (method === 'wake-delivery.status') {
      return { ok: true, value: { mode: 'automatic', selected: null, choices: [recipient] } };
    }
    assert.equal(method, 'wake-delivery.set');
    saved = payload;
    return { ok: true, value: { mode: 'pinned', selected: recipient, choices: [recipient] } };
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(MultipleConnectSettings, { rpc })); });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => renderer.root.findAllByType('button')
    .find(({ children }) => children.includes('主动唤醒投递设置')).props.onClick());
  const select = renderer.root.findByType('select');
  assert.equal(select.props.value, 'automatic');
  await act(async () => select.props.onChange({ target: { value: recipient.id } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(saved, { mode: 'pinned', id: recipient.id });
  assert.equal(select.props.value, recipient.id);
});

test('storage settings browse either host directory and migrate only when saved', async (t) => {
  const { act, create } = TestRenderer;
  const database = 'C:/existing/database';
  const cache = 'C:/existing/cache';
  const nextDatabase = 'D:/new/database';
  const nextCache = 'D:/new/cache';
  const listed = [];
  const saved = [];
  const storage = {
    messageDirectory: database, attachmentDirectory: cache,
    cacheMiB: 5120, downloadMiB: 128, cacheDays: 30, historyDays: 0,
    databaseBytes: 128, cacheBytes: 256,
  };
  const picker = {
    async listDirectory(path) {
      listed.push(path);
      const next = path === database ? nextDatabase : path === cache ? nextCache : null;
      return { path, crumbs: [{ path, name: path }],
        entries: next ? [{ path: next, name: '迁移目标' }] : [] };
    },
  };
  async function rpc(method, payload) {
    if (method === 'status') return { ok: true, value: { bots: [], workspaces: [], storage: { ...storage } } };
    assert.equal(method, 'storage.set');
    saved.push(payload);
    Object.assign(storage, payload);
    return { ok: true, value: storage };
  }
  let ui;
  await act(async () => {
    ui = create(React.createElement(WorkspaceDirectoryPickerContext.Provider, { value: picker },
      React.createElement(MultipleConnectSettings, { rpc })));
  });
  t.after(() => act(() => ui.unmount()));
  const click = (name) => act(async () => ui.root.findAllByType('button').find((button) => (
    button.props['aria-label'] === name || button.children.includes(name)
  )).props.onClick({ currentTarget: null }));
  const input = (key) => ui.root.findAllByType('input').find(({ props }) => props.id?.endsWith('-' + key));
  await click('选择消息库目录');
  assert.equal(listed.at(-1), database);
  await act(async () => ui.root.findByProps({ type: 'button', title: nextDatabase }).props.onClick());
  await click('选择此目录');
  assert.equal(input('messageDirectory').props.value, nextDatabase);
  assert.equal(input('attachmentDirectory').props.value, cache);
  await click('选择附件缓存目录');
  assert.equal(listed.at(-1), cache);
  await click('取消');
  assert.equal(input('attachmentDirectory').props.value, cache);
  await click('选择附件缓存目录');
  await act(async () => ui.root.findByProps({ type: 'button', title: nextCache }).props.onClick());
  await click('选择此目录');
  assert.equal(input('attachmentDirectory').props.value, nextCache);
  assert.equal(saved.length, 0);
  await act(async () => ui.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(saved, [{
    messageDirectory: nextDatabase, attachmentDirectory: nextCache, cacheMiB: 5120,
    downloadMiB: 128, cacheDays: 30, historyDays: 0, removePrevious: false,
  }]);
});

test('Snowluma editing preserves the saved token and parses QQ IDs', async (t) => {
  const { act, create } = TestRenderer;
  const changes = [];
  const account = {
    botId: 'snowluma-fixture', name: 'Fixture', url: 'ws://127.0.0.1:3001/',
    users: ['12345'], groups: [], hasToken: true, connected: true,
  };
  async function rpc(method, payload) {
    if (method === 'status') return { ok: true, value: { snowluma: [account] } };
    changes.push({ method, payload });
    return { ok: true, value: {} };
  }
  let ui;
  await act(async () => { ui = create(React.createElement(SnowlumaSettings, { rpc })); });
  t.after(() => act(() => ui.unmount()));
  const click = (name) => act(async () => ui.root.findAllByType('button')
    .find((button) => button.children.includes(name)).props.onClick());
  await click('编辑');
  const token = ui.root.findByProps({ name: 'token' });
  assert.equal(token.props.type, 'password');
  assert.equal(token.props.value, '');
  await act(async () => ui.root.findByProps({ name: 'groups' }).props.onChange({ target: { value: '123，456 789' } }));
  await act(async () => ui.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(changes, [{ method: 'snowluma.set', payload: {
    botId: account.botId, name: account.name, url: account.url, token: undefined,
    users: ['12345'], groups: ['123', '456', '789'],
  } }]);
  await click('移除连接');
  await click('取消');
  assert.equal(changes.length, 1);
});

test('chat settings list known conversations and can save or clear one override', async (t) => {
  const { act, create } = TestRenderer;
  const store = new ConnectStore(':memory:');
  const updates = [];
  store.receive('bot', { ...sample(1), chatName: 'Project chat' });
  async function rpc(method, payload) {
    if (method === 'status') return { ok: true, value: { bots: [{ botId: 'bot', channel: 'telegram', settings: store.settings('bot') }], workspaces: [], snowluma: [] } };
    if (method === 'conversation.list') {
      return { ok: true, value: { items: store.chats(payload.botId, Number.MAX_SAFE_INTEGER, 20, payload.query), before: null } };
    }
    updates.push(payload);
    return { ok: true, value: store.configureChat(payload.botId, payload.chatId, payload.settings) };
  }
  let ui;
  await act(async () => { ui = create(React.createElement(MultipleConnectSettings, { rpc })); });
  t.after(() => { act(() => ui.unmount()); store.close(); });
  const click = (name) => act(async () => ui.root.findAllByType('button')
    .find((item) => item.children.includes(name)).props.onClick());
  const change = (type, value, match) => act(async () => ui.root.findAllByType(type)
    .find(match).props.onChange({ target: { value, checked: value } }));
  const submit = () => act(async () => ui.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await click('管理聊天');
  await change('input', 'Project', (input) => input.props.type === 'search');
  assert.equal(ui.root.findByType('h5').children[0], 'Project chat');
  await click('配置');
  await change('select', 'custom', (select) => select.props.value === 'inherit');
  await act(async () => ui.root.findByType('form').findAllByType('input')
    .find((input) => input.props.type === 'checkbox').props.onChange({ target: { checked: true } }));
  await change('input', '7', (input) => input.props.type === 'number');
  await submit();
  assert.deepEqual(updates.at(-1), { botId: 'bot', chatId: 'chat-1', settings: { mode: 'external', autoNotify: true, threshold: 7 } });
  await click('配置');
  await change('select', 'inherit', (select) => select.props.value === 'custom');
  await submit();
  assert.equal(updates.at(-1).settings, null);
});

test('a queued internal message stays in the inbox when its chat changes to external', async () => {
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const runtime = createMultipleConnect({}, {}, { listBots: async () => [] }, { host, store });
  try {
    const calls = [];
    const connection = runtime.connection('bot', { ask: async (...args) => { calls.push(args); return 'ok'; } });
    store.configure('bot', configured({ mode: 'internal' }));
    assert.equal(connection.receive(sample(1)), 'internal');
    const run = askInWorkspaceSession({ harness: { multipleConnect: connection }, key: 'chat-1', text: sample(1).text });
    store.configureChat('bot', 'chat-1', { mode: 'external', autoNotify: false, threshold: 1 });
    await assert.rejects(run, { code: 'turn-stopped' });
    assert.deepEqual(calls, []);
    assert.equal(store.message('bot', 'chat-1', '1').text, sample(1).text);
  } finally { await runtime.close(); }
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

test('Snowluma steers and interrupts only turns started by that exact chat, otherwise queues', async () => {
  const wires = [];
  const delivered = [];
  const starts = [];
  const steered = [];
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const deliveryService = createDeliveryService();
  let current, mode = 'steer';
  let stops = 0;
  const agent = {
    status: 'idle', session: { events: [] },
    inject: (message) => steered.push(message.content[0].text),
    cancel: () => {
      stops += 1;
      current.reject(Object.assign(new Error('stopped'), { code: 'turn-stopped' }));
    },
  };
  const handlers = new Map();
  const ctx = {
    typertGateway: { invoke() {}, stream() {} },
    get: (key) => key === 'agents' ? { get: () => agent } : undefined,
    on: (name, listener) => { handlers.set(name, listener); return () => handlers.delete(name); },
  };
  class Socket extends EventTarget {
    readyState = 1;
    constructor() { super(); wires.push(this); }
    event(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(text) {
      const { action, params, echo } = JSON.parse(text);
      delivered.push({ action, params });
      this.event({ echo, status: 'ok', retcode: 0, data: { message_id: 10 } });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  class Harness {
    constructor({ controlExecutor }) {
      this.control = controlExecutor;
    }
    async ask(sessionId, content, { control, signal }) {
      const turn = starts.length + 1;
      const promptRpcId = 'prompt-' + turn;
      starts.push(content[0].text);
      agent.status = 'running';
      agent.session.id = sessionId;
      agent.session.events = [
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { source: { rpcId: promptRpcId } } },
      ];
      const entry = { sessionId, control, turn, promptRpcId };
      current = entry;
      try {
        return await new Promise((resolve, reject) => {
          Object.assign(entry, { resolve, reject });
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      } finally { current = undefined; agent.status = 'idle'; }
    }
    route(action, sessionId, control, text) {
      if (!current || sessionId !== current.sessionId || control.owner !== current.control.owner || control.key !== current.control.key) return false;
      return this.control({ sessionId, action, text, expectedTurn: current.turn, promptRpcId: current.promptRpcId, inputRpcId: 'steering' });
    }
    async steerActiveTurn(sessionId, text, control) { return this.route('steer', sessionId, control, text); }
    async stopActiveTurn(sessionId, control) { return this.route('stop', sessionId, control); }
    stopManagedProcess() {}
  }
  const runtime = createMultipleConnect({}, {}, deliveryService, { store, host });
  const manager = createSnowlumaManager({
    ctx, runtime, deliveryService, config: { humanizeDefaults: () => ({ busyMessageMode: mode }) },
    logger: { warn: (message, error) => assert.fail(message + ' ' + error) }, Socket, Harness,
  });
  try {
    const config = { name: 'QQ', url: 'ws://127.0.0.1:3001', groups: [], users: ['20', '21'] };
    const { botId } = manager.configure(config);
    store.configure(botId, configured({ mode: 'internal' }));
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    async function incoming(messageId, userId, text) {
      wires[0].event({ post_type: 'message', message_type: 'private', self_id: 10, user_id: userId,
        message_id: messageId, message: [{ type: 'text', data: { text } }] });
      await tick();
    }
    await incoming(1, 20, 'first');
    await incoming(2, 20, 'steer me');
    assert.match(steered[0], /steer me/u);
    assert.equal(starts.length, 1);
    mode = 'interrupt';
    await incoming(3, 21, 'other chat');
    assert.equal(stops, 0);
    assert.equal(starts.length, 1);
    const question = Promise.withResolvers();
    const interaction = handlers.get('user-questions/request')({ agent }, () => question.promise);
    await incoming(4, 20, 'wait for approval');
    assert.equal(stops, 0);
    question.resolve();
    await interaction;
    await incoming(5, 20, 'interrupt me');
    assert.equal(stops, 1);
    assert.match(starts[1], /other chat/u);
    current.resolve('reply to other');
    await tick();
    assert.match(starts[2], /wait for approval/u);
    manager.configure({ ...config, botId, busyMessageMode: 'queue' });
    assert.equal(wires.length, 1);
    await incoming(6, 20, 'plain queue');
    assert.equal(stops, 1);
    assert.equal(steered.length, 1);
    current.resolve('reply to waiting chat');
    await tick();
    assert.match(starts[3], /interrupt me/u);
    current.resolve('reply to interrupt');
    await tick();
    assert.match(starts[4], /plain queue/u);
    current.resolve('reply to queued');
    await tick();
    assert.ok(delivered.some(({ params }) => params.user_id === 21 && params.message.some(({ data }) => data.text === 'reply to other')));
    assert.equal(store.readMessages(botId, '10:private:20', Number.MAX_SAFE_INTEGER, 30).length, 5);
  } finally { await manager.close(); await runtime.close(); }
});

test('five platform envelopes preserve the same message details in either mode without preloading originals', async () => {
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const delivery = { listBots: async () => [{ botId: 'internal' }, { botId: 'external' }] };
  const runtime = createMultipleConnect({}, {}, delivery, { store, host });
  const tools = new Map();
  installInboxTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, runtime, delivery);
  const feishu = { message: { message_id: 'feishu', chat_id: 'chat', chat_type: 'group', message_type: 'merge_forward',
    content: '{}', parent_id: 'parent' } };
  const snow = normalizeSnowlumaMessage({
    post_type: 'message', message_type: 'group', self_id: 1, user_id: 2, group_id: 3, message_id: -11,
    message: 'hello[CQ:forward,id=forward-1][CQ:file,name=big.mp4,size=10737418240,id=group-file]',
  }, { users: [], groups: ['3'] });
  const telegram = normalizeTelegramUpdate({ update_id: 100, message: {
    message_id: 999, from: { id: 5 }, chat: { type: 'private', id: 5 }, media_group_id: 'album-1',
    caption: 'caption', forward_origin: { type: 'hidden_user', sender_user_name: 'original' },
    video: { file_id: 'native-id', file_name: 'big.mp4', file_size: 10 * 1024 ** 3 },
  } }, { richInbox: true });
  const sampleRecords = [
    snow,
    { ...sample('feishu'), ...feishuInboxContent(feishu, {}) },
    qqInboxRecord({ messageId: 'qq', kind: 'c2c', senderId: 'user', refMsgIdx: 'quote-id',
      msgElements: [{ content: 'first' }, { content: 'second' }],
      attachments: [{ filename: 'file.pdf', url: 'https://file.qq.com/?key=abcd', size: 100 }] }, 'qq-chat'),
    { ...sample('weixin'), ...weixinInboxContent({ item_list: [
      { text_item: { text: 'one' } }, { text_item: { text: 'two' } },
      { voice_item: { text: 'transcript', media: { aes_key: 'private-key', encrypt_query_param: 'private-query' } } },
    ] }) },
    { ...telegram, text: telegram.content, ...telegram.inbox },
  ].map(({ messageId, conversationId, senderId, text, replyTo, attachments, receivedAt,
    chatId, forwards, parts, forwardOrigin, albumId }) => ({
    messageId, conversationId, senderId, text, replyTo, attachments, receivedAt: receivedAt ?? 10,
    chatId, forwards, parts, forwardOrigin, albumId,
  }));
  try {
    store.configure('internal', configured({ mode: 'internal' }));
    let downloads = 0;
    for (const mode of ['internal', 'external']) {
      runtime.connection(mode).bindInboxProvider({ open() { downloads += 1; } });
      for (const event of sampleRecords) assert.equal(runtime.connection(mode).receive(event), mode);
    }
    assert.equal(downloads, 0);
    assert.deepEqual(snow.forwards, [{ id: 'forward-1' }]);
    assert.equal(snow.attachments[0].size, 10 * 1024 ** 3);
    assert.equal(sampleRecords[2].replyTo.content, 'first\nsecond');
    assert.equal(sampleRecords[3].text, 'one\ntwo\ntranscript');
    assert.equal(telegram.inbox.messageId, '999');
    for (const { conversationId, messageId } of sampleRecords) {
      const read = async (botId) => {
        const { items } = await tools.get('read_im_messages').execute({ botId, conversationId, messageId });
        const { cursor, ...fields } = items[0];
        return fields;
      };
      const inside = await read('internal');
      assert.deepEqual(inside, await read('external'));
      assert.doesNotMatch(JSON.stringify(inside), /key=abcd|private-key|private-query|native-id|group-file/u);
    }
  } finally { await runtime.close(); }
});

test('edits and recalls update the inbox without creating new notifications or turns', () => {
  const store = new ConnectStore(':memory:');
  try {
    store.configure('bot', configured({ autoNotify: true, threshold: 2 }));
    const record = { ...sample(1), chatId: 'chat-1' };
    store.receive('bot', record);
    assert.equal(store.receive('bot', { ...record, updatedAt: 5, text: 'edited' }), 'silent');
    assert.equal(store.receive('bot', { ...record, updatedAt: 4, text: 'old' }), 'silent');
    assert.equal(store.message('bot', record.conversationId, '1').text, 'edited');
    store.recall('bot', '1', 'other chat');
    assert.equal(store.message('bot', record.conversationId, '1').text, 'edited');
    store.recall('bot', '1', 'chat-1');
    assert.equal(store.message('bot', record.conversationId, '1').details.deleted, true);
    assert.equal(store.receive('bot', record), 'silent');
    assert.equal(store.nextNotification(), undefined);
    assert.equal(store.receive('bot', sample(2)), 'notify');
  } finally { store.close(); }
});

test('OneBot follows scoped nested forwards and returns group file and album references without downloads', async () => {
  const calls = [];
  const results = new Map([
    ['get_forward_msg/A', { messages: [{ user_id: 11, message: '[CQ:forward,id=B]' }] }],
    ['get_forward_msg/B', { messages: [{ user_id: 11, message: '[CQ:forward,id=A]' }] }],
    ['get_group_root_files/', { folders: [{ folder_id: '/folder', folder_name: 'folder' }], files: [
      { file_id: 'file-id', file_name: 'large.bin', file_size: 10 * 1024 ** 3 },
    ] }],
    ['get_group_album_list/', [{ id: 'album', name: 'Photos' }]],
    ['get_group_album_media_list/', { mediaList: [{ image: { name: 'photo', defaultUrl: { url: 'https://photo.qq.com/img' } } }], nextAttachInfo: 'next' }],
  ]);
  const provider = createOneBotInboxProvider({ accountId: '1', groups: ['3'], users: [] }, {
    request: async (action, params) => {
      calls.push([action, params]);
      return results.get(action + '/' + (params.id ?? ''));
    },
  }, new AbortController().signal);
  const args = { conversationId: '1:group:3' };
  const message = { details: { forwards: [{ id: 'A' }] } };
  const first = (await provider.query('forward', { args, message })).items[0];
  const second = (await provider.query('forward', { args, message, resource: first })).items[0];
  assert.equal((await provider.query('forward', { args, message, resource: second })).status, 'forward-depth-limit');
  assert.equal((await provider.query('group-files', { args, message })).items[1].size, 10 * 1024 ** 3);
  const album = (await provider.query('group-albums', { args, message })).items[0];
  const photos = await provider.query('album-media', { args, message, resource: album });
  assert.equal(photos.items[0].attachments[0].type, 'image');
  assert.equal(photos.nextPageToken, 'next');
  assert.equal((await provider.query('history', { args: { conversationId: '1:group:4' }, message })).status, 'permission-denied');
  assert.deepEqual(calls.map(([action]) => action), ['get_forward_msg', 'get_forward_msg', 'get_group_root_files',
    'get_group_album_list', 'get_group_album_media_list']);
});

test('an allowlisted OneBot group can browse folders before any message is received', async () => {
  const store = new ConnectStore(':memory:');
  const { host } = hostFixture();
  const delivery = { listBots: async () => [{ botId: 'bot', channel: 'snowluma' }] };
  const runtime = createMultipleConnect({}, {}, delivery, { store, host });
  const calls = [];
  runtime.connection('bot').bindInboxProvider(createOneBotInboxProvider({ accountId: '1', users: [], groups: ['3'] }, {
    request: async (action, args) => {
      calls.push([action, args]);
      return action === 'get_group_root_files' ? { folders: [{ folder_id: 'folder', folder_name: 'name' }] } : {};
    },
  }, new AbortController().signal));
  const commands = new Map();
  installInboxTools({ tools: { register: (tool) => commands.set(tool.name, tool) } }, runtime, delivery);
  const address = { botId: 'bot', conversationId: '1:group:3' };
  try {
    const list = await commands.get('list_im_conversations').execute({ botId: 'bot' });
    assert.deepEqual(list.availableConversations, [{ kind: 'group', conversationId: address.conversationId }]);
    const query = (args) => commands.get('read_im_resources').execute({ ...address, operation: 'group-files', ...args });
    const root = await query({});
    assert.equal(root.items[0].kind, 'folder');
    assert.equal((await query({ resourceId: root.items[0].resourceId })).items.length, 0);
    assert.equal((await query({ resourceId: root.items[0].resourceId, conversationId: '1:group:4' })).status, 'permission-denied');
    assert.deepEqual(calls, [['get_group_root_files', { group_id: 3 }],
      ['get_group_files_by_folder', { group_id: 3, folder_id: 'folder' }]]);
  } finally { await runtime.close(); }
});

test('Feishu merged submessages retain structure and report the platform attachment limit', async () => {
  const client = { im: { v1: { message: { get: async () => ({ code: 0, data: { items: [
    { message_id: 'file-child', upper_message_id: 'root', chat_id: 'chat', msg_type: 'file',
      body: { content: '{"file_key":"binary-unavailable","file_name":"doc.pdf"}' } },
    { message_id: 'other-chat', upper_message_id: 'root', chat_id: 'other', msg_type: 'text' },
  ] } }) } } } };
  const provider = createFeishuInboxProvider(client);
  const { items } = await provider.query('forward', { args: {}, message: { details: { chatId: 'chat', forwards: [{ id: 'root' }] } } });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].attachments, [{ id: '1', type: 'file', name: 'doc.pdf', unavailableReason: 'forwarded-resource-not-supported' }]);
});

test('attachment limits apply before provider calls and cache migration keeps history and files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mc-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { host } = hostFixture();
  const config = { multipleConnect: { dataDir: home } };
  const delivery = { listBots: async () => [{ botId: 'bot' }] };
  let runtime = createMultipleConnect({}, config, delivery, { host });
  try {
    const old = await runtime.storage.status();
    await runtime.storage.configure({ ...old, cacheMiB: 4, downloadMiB: 1 });
    const record = { ...sample(1), attachments: [
      { id: 'large', type: 'video', size: 10 * 1024 ** 3, source: { id: 'large' } },
      { id: 'needs-user', type: 'file', size: 2 * 1024 ** 2, source: { id: 'needs-user' } },
      { id: 'unknown-size', type: 'file', source: { id: 'oversize' } },
      { id: 'small', type: 'file', size: 2, name: 'ok.txt', source: { id: 'ok' } },
    ] };
    const connection = runtime.connection('bot');
    const downloads = [];
    connection.bindInboxProvider({ open({ id }) {
      downloads.push(id);
      return { stream: Readable.from([id === 'oversize' ? Buffer.alloc(1024 ** 2 + 1) : Buffer.from('ok')]) };
    } });
    connection.receive(record);
    assert.deepEqual(downloads, []);
    const registered = new Map();
    installInboxTools({ tools: { register: (tool) => registered.set(tool.name, tool) } }, runtime, delivery);
    const open = (attachmentId) => registered.get('open_im_attachment').execute({
      botId: 'bot', conversationId: record.conversationId, messageId: record.messageId, attachmentId,
    }).then(({ items }) => items[0]);
    assert.equal((await open('large')).status, 'cache-quota');
    const approval = await open('needs-user');
    assert.equal(approval.status, 'approval-required');
    assert.deepEqual(downloads, []);
    runtime.storage.approve(approval.requestId);
    assert.equal((await open('needs-user')).status, 'downloaded');
    assert.equal((await open('unknown-size')).status, 'attachment-limit');
    assert.equal((await open('small')).status, 'downloaded');
    assert.deepEqual(downloads, ['needs-user', 'oversize', 'ok']);
    assert.equal((await readdir(runtime.storage.root)).some((file) => file.endsWith('.part')), false);
    const next = { ...runtime.storage.settings, messageDirectory: join(home, 'database'), attachmentDirectory: join(home, 'cache'),
      removePrevious: true };
    await runtime.storage.configure(next);
    await assert.rejects(readFile(join(home, 'connections.sqlite')), { code: 'ENOENT' });
    assert.equal(runtime.store.message('bot', 'chat-1', '1').text, record.text);
    assert.equal((await open('small')).status, 'cached');
    const savedPath = (await open('small')).path;
    assert.equal(await readFile(savedPath, 'utf8'), 'ok');
    assert.ok(savedPath.startsWith(next.attachmentDirectory));
    await runtime.close();
    runtime = createMultipleConnect({}, config, delivery, { host });
    assert.equal(runtime.store.path, join(next.messageDirectory, 'connections.sqlite'));
    assert.equal(runtime.store.message('bot', 'chat-1', '1').text, record.text);
    assert.equal((await runtime.storage.status()).cacheBytes, 4);
  } finally { await runtime.close(); }
});
