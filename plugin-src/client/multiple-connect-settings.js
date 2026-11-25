import * as React from 'react';
import { h, isEnglish } from './i18n.js';

export const CONNECT_RPC = '/dsh-multiple-connect';

function label(zh, en) { return isEnglish() ? en : zh; }

function button(text, action, disabled = false) {
  return h('button', { type: 'button', className: 'dim-deliveryButton', onClick: action, disabled }, text);
}

function field(text, input) {
  return h('label', { className: 'dim-humanizeField' }, h('span', null, text), input);
}

async function invoke(rpc, endpoint, payload) {
  const result = await rpc(endpoint, payload);
  if (result?.ok !== true) throw new Error(result?.error?.message || 'Connection settings are unavailable');
  return result.value;
}

function useConnections(rpc) {
  const [status, setStatus] = React.useState();
  const [error, setError] = React.useState('');
  const refresh = React.useCallback(async () => {
    if (!rpc) return;
    try { setStatus(await invoke(rpc, 'status', {})); setError(''); }
    catch (failure) { setError(failure.message ?? String(failure)); }
  }, [rpc]);
  React.useEffect(() => {
    void refresh();
    if (!rpc) return undefined;
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh, rpc]);
  const save = async (endpoint, value) => {
    try { await invoke(rpc, endpoint, value); await refresh(); return true; }
    catch (failure) { setError(failure.message ?? String(failure)); return false; }
  };
  return { status, error, save };
}

function ConnectionSettings({ bot, save }) {
  const [draft, setDraft] = React.useState(bot.settings);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setDraft(bot.settings), [bot.settings.mode, bot.settings.toolSend, bot.settings.autoNotify, bot.settings.threshold]);
  const patch = (field, value) => setDraft((before) => ({ ...before, [field]: value }));
  const persist = async () => {
    setBusy(true);
    try { await save('connection.set', { botId: bot.botId, settings: { ...draft, threshold: Number(draft.threshold) } }); }
    finally { setBusy(false); }
  };
  return h('fieldset', { className: 'dim-humanizeField' },
    h('legend', null, bot.name ?? bot.botId),
    h('small', null, bot.channel),
    field(label('连接模式', 'Mode'), h('select', { value: draft.mode, onChange: (event) => patch('mode', event.target.value) },
      h('option', { value: 'external' }, label('外连', 'External')),
      h('option', { value: 'internal' }, label('内连', 'Internal')))),
    field(label('允许 Agent 工具发送', 'Allow Agent tool sending'),
      h('input', { type: 'checkbox', checked: draft.toolSend, onChange: (event) => patch('toolSend', event.target.checked) })),
    draft.mode === 'external' && field(label('外连自动推送', 'Notify main conversation'),
      h('input', { type: 'checkbox', checked: draft.autoNotify, onChange: (event) => patch('autoNotify', event.target.checked) })),
    draft.mode === 'external' && draft.autoNotify && field(label('累计几条时提醒', 'Messages per notification'),
      h('input', { type: 'number', min: 1, step: 1, value: draft.threshold, onChange: (event) => patch('threshold', event.target.value) })),
    button(label('保存', 'Save'), () => void persist(), busy || !Number.isSafeInteger(Number(draft.threshold)) || Number(draft.threshold) < 1));
}

export function MultipleConnectSettings({ rpc, openSession }) {
  const { status, error, save } = useConnections(rpc);
  const [workspace, setWorkspace] = React.useState('');
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  if (!rpc) return null;
  return h('section', { className: 'dim-humanizePanel' },
    h('h3', null, label('主对话与连接模式', 'Main conversation and connection modes')),
    status?.main
      ? h('div', null,
        button(label('打开主对话', 'Open main conversation'), () => openSession(status.main.sessionId), !openSession),
        confirmArchive
          ? button(label('确认归档并创建新主对话', 'Archive and replace'), () => {
            setConfirmArchive(false);
            void save('main.archive', { sessionId: status.main.sessionId });
          })
          : button(label('归档主对话', 'Archive main conversation'), () => setConfirmArchive(true)))
      : status && h('div', null,
        field(label('选择主对话工作区', 'Select the main workspace'),
          h('select', { value: workspace, onChange: (event) => setWorkspace(event.target.value) },
            h('option', { value: '' }, label('请选择', 'Choose a workspace')),
            status.workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title)))),
        button(label('创建主对话', 'Create main conversation'), () => void save('workspace.set', { workspaceId: workspace }), !workspace)),
    error && h('p', { role: 'alert' }, error),
    status?.bots.map((bot) => h(ConnectionSettings, {
      key: bot.botId, bot: { ...bot, name: status.snowluma.find((item) => item.botId === bot.botId)?.name }, save,
    })));
}

function SnowlumaEditor({ initial, save, dismiss }) {
  const [value, setValue] = React.useState(() => ({
    name: initial?.name ?? '', url: initial?.url ?? 'ws://127.0.0.1:3001/',
    token: '', users: initial?.users?.join(', ') ?? '', groups: initial?.groups?.join(', ') ?? '',
  }));
  const [busy, setBusy] = React.useState(false);
  const input = (key, type = 'text') => h('input', {
    type, value: value[key], autoComplete: 'off',
    onChange: (event) => setValue({ ...value, [key]: event.target.value }),
  });
  const submit = async () => {
    setBusy(true);
    const ids = (value) => value.split(/[\s,，]+/u).filter(Boolean);
    try {
      if (await save('snowluma.set', {
        ...value, ...(initial ? { botId: initial.botId } : {}),
        ...(initial && !value.token ? { token: undefined } : {}),
        users: ids(value.users), groups: ids(value.groups),
      })) dismiss();
    } finally { setBusy(false); }
  };
  return h('div', { className: 'dim-humanizeField' },
    field(label('连接名称', 'Connection name'), input('name')),
    field('OneBot WebSocket URL', input('url')),
    field(initial?.hasToken ? label('Access Token（留空沿用）', 'Access Token (blank keeps current)') : 'Access Token', input('token', 'password')),
    field(label('允许的 QQ 私聊账号', 'Allowed private QQ accounts'), input('users')),
    field(label('允许的 QQ 群号', 'Allowed QQ groups'), input('groups')),
    button(label('保存连接', 'Save connection'), () => void submit(), busy || !value.name.trim()),
    button(label('取消', 'Cancel'), dismiss, busy));
}

export function SnowlumaSettings({ rpc, openDelivery }) {
  const { status, error, save } = useConnections(rpc);
  const [editor, setEditor] = React.useState(null);
  const [removing, setRemoving] = React.useState(null);
  return h('section', { className: 'dim-humanizePanel' },
    h('h3', null, 'Snowluma'),
    error && h('p', { role: 'alert' }, error),
    button(label('新增 Snowluma 连接', 'Add Snowluma connection'), () => setEditor({})),
    editor && h(SnowlumaEditor, { key: editor.botId ?? 'new', initial: editor.botId ? editor : null, save, dismiss: () => setEditor(null) }),
    status?.snowluma.map((account) => h('fieldset', { key: account.botId, className: 'dim-humanizeField' },
      h('legend', null, account.name),
      h('span', null, account.connected ? label('已连接', 'Connected') : label('未连接', 'Disconnected')),
      button(label('编辑', 'Edit'), () => setEditor(account)),
      button(label('投递目标', 'Delivery targets'), () => openDelivery({ botId: account.botId, botName: account.name, channel: 'snowluma', connected: account.connected })),
      removing === account.botId
        ? button(label('确认移除连接', 'Remove this connection'), () => void save('snowluma.delete', { botId: account.botId })
          .then((saved) => { if (saved) setRemoving(null); }))
        : button(label('移除连接', 'Remove connection'), () => setRemoving(account.botId)))));
}
