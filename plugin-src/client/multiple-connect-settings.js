import * as React from 'react';
import { h, isEnglish, localizeText } from './i18n.js';
import { WorkspaceDirectoryPicker } from './workspace-directory-picker.js';
import { WorkspaceDirectoryPickerContext } from './workspace-editor.js';
import { BUSY_MESSAGE_MODES } from '../../src/channels/shared/message-mode.mjs';

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

function routingFields(draft, patch, modeLabel, { disabled = false } = {}) {
  return [
    field(modeLabel, h('select', { value: draft.mode, disabled, onChange: (event) => patch('mode', event.target.value) },
      h('option', { value: 'external' }, label('外连', 'External')),
      h('option', { value: 'internal' }, label('内连', 'Internal')))),
    draft.mode === 'external' && field(localizeText('外连自动提醒'),
      h('input', { type: 'checkbox', checked: draft.autoNotify, disabled, onChange: (event) => patch('autoNotify', event.target.checked) })),
    draft.mode === 'external' && draft.autoNotify && field(localizeText('每个聊天累计几条时提醒'),
      h('input', { type: 'number', min: 1, step: 1, value: draft.threshold, disabled, onChange: (event) => patch('threshold', event.target.value) })),
  ];
}

function validThreshold(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 1;
}

function validRoutingSettings(draft) {
  return draft.mode === 'internal' || !draft.autoNotify || validThreshold(draft.threshold);
}

function routingPayload(draft, previous) {
  return { ...draft, threshold: validThreshold(draft.threshold) ? Number(draft.threshold) : previous.threshold };
}

function ChatEditor({ chat, save, cancel }) {
  const [draft, setDraft] = React.useState(chat.settings);
  const [custom, setCustom] = React.useState(chat.override !== null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const patch = (key, value) => setDraft((before) => ({ ...before, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    if (busy || (custom && !validRoutingSettings(draft))) return;
    setBusy(true);
    setError('');
    try {
      await save(custom ? routingPayload(draft, chat.settings) : null);
    } catch (failure) { setError(failure.message ?? String(failure)); }
    finally { setBusy(false); }
  }
  return h('form', { className: 'dim-connectForm', onSubmit: submit, 'aria-busy': busy },
    field(localizeText('聊天配置'), h('select', {
      value: custom ? 'custom' : 'inherit', disabled: busy, onChange: (event) => setCustom(event.target.value === 'custom'),
    },
    h('option', { value: 'inherit' }, chat.parentId ? localizeText('继承群设置') : localizeText('跟随默认配置')),
    h('option', { value: 'custom' }, localizeText('单独配置')))),
    custom && h('div', { className: 'dim-connectGrid' }, ...routingFields(draft, patch, label('连接模式', 'Connection mode'), { disabled: busy })),
    error && h('p', { role: 'alert', className: 'dim-connectAlert' }, error),
    h('div', { className: 'dim-connectActions' },
      button(label('取消', 'Cancel'), cancel, busy),
      h('button', { type: 'submit', className: 'dim-deliveryButton dim-connectButton', 'data-kind': 'primary',
        disabled: busy || (custom && !validRoutingSettings(draft)) }, localizeText('保存聊天配置'))));
}

function ConversationSettings({ botId, rpc, defaults }) {
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [before, setBefore] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [refresh, setRefresh] = React.useState(0);
  const generation = React.useRef(0);
  const load = React.useCallback(async (cursor) => {
    const id = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const page = await invoke(rpc, 'conversation.list', { botId, query, kind, before: cursor });
      if (generation.current !== id) return;
      setItems((old) => cursor ? [...old, ...page.items] : page.items);
      setBefore(page.before);
    } catch (failure) {
      if (generation.current === id) setError(failure.message ?? String(failure));
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }, [rpc, botId, query, kind]);
  React.useEffect(() => {
    setBefore(null);
    void load();
    return () => { generation.current += 1; };
  }, [load, refresh, defaults.mode, defaults.autoNotify, defaults.threshold]);
  React.useEffect(() => {
    if (editing || items.length > 50 || loading) return undefined;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [editing, items.length, load, loading]);
  async function save(chatId, settings) {
    await invoke(rpc, 'conversation.set', { botId, chatId, settings });
    setEditing(null);
    setRefresh((previous) => previous + 1);
  }
  return h('section', { className: 'dim-connectForm dim-connectChats', 'aria-busy': loading },
    h('div', { className: 'dim-connectGrid' },
      settingsField(localizeText('搜索聊天'), h('input', { type: 'search', className: 'dim-connectInput',
        value: query, placeholder: localizeText('名称或聊天 ID'), onChange: (event) => setQuery(event.target.value) })),
      field(localizeText('聊天类型'), h('select', { value: kind, onChange: (event) => setKind(event.target.value) },
        h('option', { value: '' }, localizeText('全部')),
        h('option', { value: 'group' }, localizeText('群聊和频道')),
        h('option', { value: 'direct' }, label('私聊', 'Direct chats'))))),
    h('div', { className: 'dim-connectActions' },
      button(localizeText('刷新聊天列表'), () => setRefresh((previous) => previous + 1), loading)),
    error && h('p', { role: 'alert', className: 'dim-connectAlert' }, error),
    !loading && !error && !items.length && h('p', { className: 'dim-connectHint' },
      localizeText('没有符合条件的聊天。通过接收规则的新聊天会自动出现在这里。')),
    items.map((chat) => {
      const kindLabel = chat.parentId ? label('话题', 'Topic') : chat.kind === 'group' ? label('群聊', 'Group') : label('私聊', 'Direct chat');
      const mode = chat.settings.mode === 'internal' ? label('内连', 'Internal') : label('外连', 'External');
      const policy = chat.override ? localizeText('单独配置') : localizeText('继承');
      const reminder = chat.settings.mode === 'external' && (chat.settings.autoNotify
        ? localizeText('每 {count} 条提醒').replace('{count}', chat.settings.threshold)
        : localizeText('提醒关闭'));
      return h('article', { key: chat.chatId, className: 'dim-globalSection dim-connectCard' },
        h('div', { className: 'dim-connectFieldHead' },
          h('div', null,
            h('h5', { className: 'dim-connectTitle' }, chat.name ?? chat.parentName ?? chat.chatId),
            h('p', { className: 'dim-connectHint dim-connectChatMeta' }, [kindLabel, chat.chatId, mode, policy, reminder].filter(Boolean).join(' · '))),
          editing !== chat.chatId && button(localizeText('配置'), () => setEditing(chat.chatId))),
        editing === chat.chatId && h(ChatEditor, { chat,
          save: (settings) => save(chat.chatId, settings), cancel: () => setEditing(null),
        }));
    }),
    before && button(localizeText('加载更多聊天'), () => void load(before), loading));
}

function ConnectionSettings({ bot, save, rpc }) {
  const [draft, setDraft] = React.useState(bot.settings);
  const [busy, setBusy] = React.useState(false);
  const [showChats, setShowChats] = React.useState(false);
  React.useEffect(() => setDraft(bot.settings), [bot.settings.mode, bot.settings.toolSend, bot.settings.autoNotify, bot.settings.threshold]);
  const patch = (field, value) => setDraft((before) => ({ ...before, [field]: value }));
  const persist = async () => {
    setBusy(true);
    try { await save('connection.set', { botId: bot.botId, settings: routingPayload(draft, bot.settings) }); }
    finally { setBusy(false); }
  };
  return h('section', { className: 'dim-globalSection dim-connectCard' },
    h('h4', { className: 'dim-connectTitle' }, bot.name ?? bot.botId),
    h('small', null, bot.channel),
    h('p', { className: 'dim-connectHint' }, localizeText('新聊天和未单独配置的聊天使用这套默认设置。')),
    h('div', { className: 'dim-connectGrid' }, ...routingFields(draft, patch, localizeText('默认连接模式')),
      field(label('允许 Agent 工具发送', 'Allow Agent tool sending'),
        h('input', { type: 'checkbox', checked: draft.toolSend, onChange: (event) => patch('toolSend', event.target.checked) }))),
    h('div', { className: 'dim-connectActions' },
      h('button', { type: 'button', className: 'dim-deliveryButton', 'aria-expanded': showChats,
        onClick: () => setShowChats((open) => !open) }, showChats ? localizeText('收起聊天') : localizeText('管理聊天')),
      button(localizeText('保存默认配置'), () => void persist(), busy || !validRoutingSettings(draft))),
    showChats && h(ConversationSettings, { botId: bot.botId, rpc, defaults: bot.settings }));
}

function RoutingConnections({ status, save, rpc, channel }) {
  const bots = (status?.bots ?? []).filter((bot) => !channel || bot.channel === channel);
  return bots.map((bot) => h(ConnectionSettings, {
    key: bot.botId, bot: { ...bot, name: status.snowluma.find((item) => item.botId === bot.botId)?.name }, save, rpc,
  }));
}

function ChannelRoutingForm({ channel, rpc }) {
  const { status, error, save } = useConnections(rpc);
  return h(React.Fragment, null,
    error && h('p', { role: 'alert', className: 'dim-connectAlert' }, error),
    status && !status.bots.some((bot) => bot.channel === channel)
      && h('p', { className: 'dim-connectHint' }, localizeText('添加连接后可配置聊天。')),
    h(RoutingConnections, { status, save, rpc, channel }));
}

export function ChannelRoutingSettings({ channel, rpc }) {
  const [open, setOpen] = React.useState(false);
  if (!rpc) return null;
  return h('details', { className: 'dim-globalSection dim-connectCard dim-connectChannel',
    onToggle: (event) => setOpen(event.currentTarget.open) },
  h('summary', null, localizeText('聊天与连接模式')),
  open && h(ChannelRoutingForm, { channel, rpc }));
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
    h(RoutingConnections, { status, save, rpc }));
}

function SnowlumaEditor({ initial, save, dismiss }) {
  const [value, setValue] = React.useState(() => ({
    name: initial?.name ?? '', url: initial?.url ?? 'ws://127.0.0.1:3001/',
    token: '', users: initial?.users?.join(', ') ?? '', groups: initial?.groups?.join(', ') ?? '',
    busyMessageMode: initial?.busyMessageMode ?? '',
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
      const { busyMessageMode, ...other } = value;
      if (await save('snowluma.set', {
        ...other, url: value.url.trim(), ...(initial ? { botId: initial.botId } : {}),
        ...(busyMessageMode || initial?.busyMessageMode ? { busyMessageMode: busyMessageMode || null } : {}),
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
      field(localizeText('消息处理方式'), h('select', {
        name: 'busyMessageMode', value: value.busyMessageMode, className: 'dim-connectInput', disabled: busy,
        onChange: (event) => setValue((previous) => ({ ...previous, busyMessageMode: event.target.value })),
      },
        h('option', { value: '' }, localizeText('跟随全局默认')),
        ...BUSY_MESSAGE_MODES.map((mode) => h('option', { value: mode, key: mode }, {
          interrupt: localizeText('打断重发'), queue: localizeText('排队等待'), steer: localizeText('注入纠偏'),
        }[mode])))),
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
