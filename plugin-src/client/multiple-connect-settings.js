import * as React from 'react';
import { h, isEnglish } from './i18n.js';
import { WorkspaceDirectoryPicker } from './workspace-directory-picker.js';
import { WorkspaceDirectoryPickerContext } from './workspace-editor.js';

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
  if (result?.error?.code === 'default-workspace-unavailable') {
    throw new Error('无法定位 DSH 宿主的文档目录，请选择一个已有工作区。');
  }
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
  const save = async (endpoint, value, onError = setError) => {
    try { await invoke(rpc, endpoint, value); await refresh(); return true; }
    catch (failure) { onError(failure.message ?? String(failure)); return false; }
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

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  return bytes < 1024 ** 3 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : (bytes / 1024 ** 3).toFixed(2) + ' GiB';
}

const storageDirectories = [
  { key: 'messageDirectory', name: '消息库目录（Host 路径）', pickerTitle: '选择消息库目录', usage: 'databaseBytes' },
  { key: 'attachmentDirectory', name: '附件缓存目录（Host 路径）', pickerTitle: '选择附件缓存目录', usage: 'cacheBytes' },
];
const storageLimits = [
  ['cacheMiB', '附件缓存上限（MiB）', 1],
  ['downloadMiB', '单附件下载上限（MiB）', 1],
  ['cacheDays', '附件缓存保留天数', 1],
  ['historyDays', '消息保留天数（0 为永久）', 0],
];

function settingsField(title, input, key) {
  return h('label', { key, className: 'dim-connectField' }, h('span', null, title), input);
}

function StorageSettings({ storage, save }) {
  const directoryPicker = React.useContext(WorkspaceDirectoryPickerContext);
  const titleId = React.useId();
  const directoryId = React.useId();
  const trigger = React.useRef(null);
  const { messageDirectory, attachmentDirectory, cacheMiB, downloadMiB, cacheDays, historyDays } = storage;
  const [draft, setDraft] = React.useState({ messageDirectory, attachmentDirectory, cacheMiB, downloadMiB, cacheDays, historyDays });
  React.useEffect(() => setDraft({ messageDirectory, attachmentDirectory, cacheMiB, downloadMiB, cacheDays, historyDays }),
    [messageDirectory, attachmentDirectory, cacheMiB, downloadMiB, cacheDays, historyDays]);
  const [busy, setBusy] = React.useState(false);
  const [removePrevious, setRemovePrevious] = React.useState(false);
  const [browse, setBrowse] = React.useState(null);
  const [feedback, setFeedback] = React.useState(null);
  const moving = draft.messageDirectory !== messageDirectory || draft.attachmentDirectory !== attachmentDirectory;
  const changed = moving || storageLimits.some(([key]) => String(draft[key]) !== String(storage[key]));
  const update = (key, value) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setFeedback(null);
  };
  const updateDirectory = (key, value) => {
    if (draft[key] === value) return;
    update(key, value);
    setRemovePrevious(false);
  };
  const closePicker = () => {
    setBrowse(null);
    queueMicrotask(() => trigger.current?.focus?.());
  };
  const persist = async (event) => {
    event.preventDefault();
    if (!changed || busy || browse) return;
    setBusy(true);
    setFeedback(null);
    try {
      const limits = Object.fromEntries(storageLimits.map(([key]) => [key, Number(draft[key])]));
      const settings = { messageDirectory: draft.messageDirectory, attachmentDirectory: draft.attachmentDirectory, ...limits };
      if (await save('storage.set', { ...settings, removePrevious: moving && removePrevious },
        (message) => setFeedback({ message, error: true }))) {
        setRemovePrevious(false);
        setFeedback({ message: '存储设置已保存' });
      }
    } finally { setBusy(false); }
  };
  return h('section', { className: 'dim-globalSection dim-connectCard dim-storageCard', 'aria-labelledby': titleId },
    h('h4', { className: 'dim-connectTitle', id: titleId }, '消息与附件存储'),
    storage.warning && h('p', { className: 'dim-connectAlert', role: 'alert' }, storage.warning),
    h('form', { className: 'dim-connectForm', onSubmit: persist, 'aria-busy': busy },
      h('div', { className: 'dim-connectFields' }, storageDirectories.map((entry) => {
        const { key, name, pickerTitle, usage } = entry;
        const id = `${directoryId}-${key}`;
        return h('div', { key, className: 'dim-connectField' },
          h('div', { className: 'dim-connectFieldHead' },
            h('label', { htmlFor: id }, name),
            h('span', { className: 'dim-storageUsage' }, formatStorageBytes(storage[usage]))),
          h('div', { className: 'dim-storagePathRow' },
            h('input', {
              id, type: 'text', className: 'dim-connectInput dim-connectInput--path', value: draft[key],
              required: true, disabled: busy, spellCheck: false, autoComplete: 'off',
              onChange: (event) => updateDirectory(key, event.target.value),
            }),
            h('button', {
              type: 'button', className: 'dim-deliveryButton dim-connectButton',
              'aria-label': pickerTitle, disabled: busy || !directoryPicker,
              onClick: (event) => { trigger.current = event.currentTarget; setBrowse(entry); },
            }, '选择目录')));
      })),
      h('div', { className: 'dim-connectGrid dim-storageLimits' }, storageLimits.map(([key, title, minimum]) =>
        settingsField(title, h('input', {
          type: 'number', className: 'dim-connectInput', min: minimum, max: 1_048_576, step: 1,
          required: true, disabled: busy, value: draft[key], onChange: (event) => update(key, event.target.value),
        }), key))),
      h('div', { className: 'dim-connectActions dim-storageActions' },
        moving && h('label', { className: 'dim-storageMove' },
          h('input', {
            type: 'checkbox', checked: removePrevious, disabled: busy,
            onChange: (event) => setRemovePrevious(event.target.checked),
          }), '迁移成功后删除旧副本'),
        h('button', {
          type: 'submit', className: 'dim-deliveryButton dim-connectButton', 'data-kind': 'primary', disabled: busy || !changed,
        }, busy ? (moving ? '迁移并保存中…' : '保存中…') : '保存存储设置')),
      feedback && h('p', { className: feedback.error ? 'dim-connectAlert' : 'dim-connectSuccess', role: feedback.error ? 'alert' : 'status' },
        feedback.message)),
    !!storage.requests?.length && h('ul', { className: 'dim-storageRequests' },
      storage.requests.map(({ id, name, size, approved }) => h('li', { key: id },
        h('span', null, name || '附件', ' · ', formatStorageBytes(size)),
        button(approved ? '已允许本次下载' : '允许本次下载', () => void save('storage.approve', { id }), approved)))),
    browse && h(WorkspaceDirectoryPicker, {
      open: true, startPath: draft[browse.key], picker: directoryPicker, title: browse.pickerTitle,
      pathLabel: '存储目录绝对路径', notice: '保存存储设置后才会迁移数据。',
      onPicked: (path) => { if (path) updateDirectory(browse.key, path); closePicker(); }, onCancel: closePicker,
    }));
}

export function MultipleConnectSettings({ rpc, openSession }) {
  const { status, error, save } = useConnections(rpc);
  const [workspace, setWorkspace] = React.useState('');
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [creatingMain, setCreatingMain] = React.useState(false);
  async function createMain(useDefault) {
    setCreatingMain(true);
    try {
      if (useDefault) await save('main.setup-default', {});
      else await save('workspace.set', { workspaceId: workspace });
    } finally {
      setCreatingMain(false);
    }
  }
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
      : status && h('div', { 'aria-busy': creatingMain },
        button('使用默认工作区创建主对话',
          () => void createMain(true), creatingMain),
        creatingMain && h('p', { role: 'status' }, '正在创建主对话…'),
        field(label('选择主对话工作区', 'Select the main workspace'),
          h('select', { value: workspace, disabled: creatingMain, onChange: (event) => setWorkspace(event.target.value) },
            h('option', { value: '' }, label('请选择', 'Choose a workspace')),
            status.workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title)))),
        button(label('创建主对话', 'Create main conversation'), () => void createMain(false), creatingMain || !workspace)),
    error && h('p', { role: 'alert' }, error),
    status?.storage && h(StorageSettings, { storage: status.storage, save }),
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
  const [error, setError] = React.useState('');
  const titleId = React.useId();
  const hintId = React.useId();
  const input = (key, props = {}) => h('input', {
    type: 'text', name: key, value: value[key], className: 'dim-connectInput', autoComplete: 'off',
    spellCheck: false, disabled: busy, ...props,
    onChange: (event) => {
      setValue((previous) => ({ ...previous, [key]: event.target.value }));
      setError('');
    },
  });
  const submit = async (event) => {
    event.preventDefault();
    if (busy || !value.name.trim() || !value.url.trim()) return;
    setBusy(true);
    setError('');
    const ids = (value) => value.split(/[\s,，]+/u).filter(Boolean);
    try {
      if (await save('snowluma.set', {
        ...value, url: value.url.trim(), ...(initial ? { botId: initial.botId } : {}),
        ...(initial && !value.token ? { token: undefined } : {}),
        users: ids(value.users), groups: ids(value.groups),
      }, setError)) dismiss();
    } finally { setBusy(false); }
  };
  return h('section', { className: 'dim-globalSection dim-connectCard', 'aria-labelledby': titleId },
    h('h4', { className: 'dim-connectTitle', id: titleId }, initial ? '编辑连接' : '新增连接'),
    h('form', { className: 'dim-connectForm', onSubmit: submit, 'aria-busy': busy },
      h('div', { className: 'dim-connectGrid' },
        settingsField('连接名称', input('name', { required: true, maxLength: 80, autoFocus: true })),
        settingsField('OneBot WebSocket URL', input('url', { type: 'url', required: true, inputMode: 'url' }))),
      settingsField(initial?.hasToken ? 'Access Token（留空沿用）' : 'Access Token', input('token', { type: 'password' })),
      h('fieldset', { className: 'dim-snowlumaAccess', 'aria-describedby': hintId },
        h('legend', { className: 'dim-connectTitle' }, '接收范围'),
        h('div', { className: 'dim-connectGrid' },
          settingsField('允许的 QQ 私聊账号', input('users')),
          settingsField('允许的 QQ 群号', input('groups'))),
        h('p', { className: 'dim-connectHint', id: hintId }, '多个号码用逗号或空格分隔。两项留空时不会接收消息。')),
      error && h('p', { className: 'dim-connectAlert', role: 'alert' }, error),
      h('div', { className: 'dim-connectActions' },
        button('取消', dismiss, busy),
        h('button', { type: 'submit', className: 'dim-deliveryButton dim-connectButton', 'data-kind': 'primary',
          disabled: busy || !value.name.trim() || !value.url.trim() }, busy ? '保存中…' : '保存连接'))));
}

export function SnowlumaSettings({ rpc, openDelivery }) {
  const { status, error, save } = useConnections(rpc);
  const [editor, setEditor] = React.useState(null);
  const [removing, setRemoving] = React.useState(null);
  const [deleting, setDeleting] = React.useState(false);
  const remove = async (botId) => {
    setDeleting(true);
    try {
      if (await save('snowluma.delete', { botId })) {
        setRemoving(null);
        setEditor((previous) => previous?.botId === botId ? null : previous);
      }
    } finally { setDeleting(false); }
  };
  return h('section', { className: 'dim-snowlumaPanel' },
    h('header', { className: 'dim-snowlumaHeader' },
      h('h3', null, 'Snowluma'),
      !editor && h('button', { type: 'button', className: 'dim-deliveryButton dim-connectButton', 'data-kind': 'primary',
        onClick: () => setEditor({}) }, '新增 Snowluma 连接')),
    error && h('p', { className: 'dim-connectAlert', role: 'alert' }, error),
    editor && h(SnowlumaEditor, { key: editor.botId ?? 'new', initial: editor.botId ? editor : null, save, dismiss: () => setEditor(null) }),
    status?.snowluma.length === 0 && !editor && h('p', { className: 'dim-globalSection dim-connectHint' }, '暂无 Snowluma 连接'),
    status?.snowluma.map((account) => h('article', { key: account.botId, className: 'dim-globalSection dim-connectCard' },
      h('div', { className: 'dim-connectFieldHead' },
        h('h4', { className: 'dim-connectTitle' }, account.name),
        h('span', { className: 'dim-snowlumaStatus', 'data-connected': account.connected }, account.connected ? '已连接' : '未连接')),
      React.createElement('code', { className: 'dim-snowlumaEndpoint', title: account.url }, account.url),
      removing === account.botId
        ? h('div', { className: 'dim-connectActions', 'aria-busy': deleting },
          button('取消', () => setRemoving(null), deleting),
          h('button', { type: 'button', className: 'dim-deliveryButton', 'data-kind': 'danger',
            disabled: deleting, onClick: () => void remove(account.botId) }, '确认移除连接'))
        : h('div', { className: 'dim-connectActions' },
          button('移除连接', () => setRemoving(account.botId), deleting),
          button('投递目标', () => openDelivery({
            botId: account.botId, botName: account.name, channel: 'snowluma', connected: account.connected,
          }), !openDelivery),
          button('编辑', () => { setRemoving(null); setEditor(account); }, editor !== null)))));
}
