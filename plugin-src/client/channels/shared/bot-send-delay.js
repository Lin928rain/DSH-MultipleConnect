import * as React from 'react';
import { h } from '../../i18n.js';
import { SCALAR_HUMANIZE_FIELDS, resolvedHumanizeDefaults } from './humanize-fields.js';

export const TYPING_CAPABILITY = Object.freeze({
  full: 'full',
  c2cOnly: 'c2c-only',
  none: 'none',
});

// Which tri-state the per-bot dropdown encodes: booleans as the strings
// 'true'/'false' (the empty value means "follow global"), enums as their
// own value. Both key lists come from the shared field table.
const BOOLEAN_KEYS = SCALAR_HUMANIZE_FIELDS
  .filter((field) => field.kind === 'boolean').map((field) => field.key);
const ENUM_KEYS = SCALAR_HUMANIZE_FIELDS
  .filter((field) => field.kind === 'enum').map((field) => field.key);
const ALL_KEYS = [...BOOLEAN_KEYS, ...ENUM_KEYS];

// ── per-key draft derivation ───────────────────────────────────────

function deriveDraft(humanize) {
  const ov = humanize && typeof humanize === 'object' ? humanize : {};
  const draft = {};

  // Booleans and enums: tri-state dropdown value.
  // '' = follow global, 'true'/'false' = custom boolean, specific = custom enum
  for (const key of BOOLEAN_KEYS) {
    draft[key] = ov[key] !== undefined
      ? (ov[key] ? 'true' : 'false')
      : '';
  }
  for (const key of ENUM_KEYS) {
    draft[key] = key === 'typingIndicator' && ov[key] === 'burst' ? 'continuous' : ov[key] ?? '';
  }

  return draft;
}

function countOverrides(humanize) {
  if (!humanize || typeof humanize !== 'object') return 0;
  return ALL_KEYS.filter((key) => humanize[key] !== undefined).length;
}

function overrideLabel(humanize) {
  const n = countOverrides(humanize);
  if (n === 0) return '跟随全局';
  return `已覆盖 ${n} 项`;
}

/**
 * Build the save payload from the draft. Returns a partial section
 * (only custom keys) or null (clear). Throws FieldError on validation
 * failure.
 */
function buildPayload(draft) {
  const payload = {};

  for (const key of BOOLEAN_KEYS) {
    if (draft[key] !== '') {
      payload[key] = draft[key] === 'true';
    }
  }
  for (const key of ENUM_KEYS) {
    if (draft[key] !== '') {
      payload[key] = draft[key];
    }
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

// ── UI helpers ────────────────────────────────────────────────────

function capabilityNote(capability) {
  if (capability === TYPING_CAPABILITY.none) {
    return '该渠道没有输入状态接口。';
  }
  if (capability === TYPING_CAPABILITY.c2cOnly) {
    return '输入状态仅私聊可用。';
  }
  return null;
}

function booleanLabel(value) {
  return value ? '开' : '关';
}

/** The dropdown options for one per-bot scalar field. */
function fieldOptions(field) {
  return field.kind === 'boolean'
    ? [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]
    : field.options.filter((option) => option.value !== 'burst');
}

/** How "follow global" labels the inherited value, in the same terms as the dropdown. */
function inheritedLabel(field, value) {
  return field.kind === 'boolean'
    ? booleanLabel(value)
    : field.options.find((option) => option.value === value)?.label ?? value;
}

// ── Main component ─────────────────────────────────────────────────

export function BotHumanizeEditor({
  humanize,
  humanizeDefaults = null,
  capability = TYPING_CAPABILITY.full,
  disabled = false,
  onSave,
}) {
  const defaults = resolvedHumanizeDefaults(humanizeDefaults);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(() => deriveDraft(humanize));
  const [dirty, setDirty] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Re-sync after the parent refreshes the bot snapshot — but only while
  // the draft is clean. Silent 15s polling rebuilds snapshot objects with
  // fresh identities; a mounted editor owns its unsaved edits.
  React.useEffect(() => {
    if (dirty) return;
    setDraft(deriveDraft(humanize));
  }, [humanize, humanizeDefaults, dirty]);

  const beginChange = () => {
    setSaveError(null);
    setSaved(false);
  };

  const updateDraft = (updater) => {
    beginChange();
    setDirty(true);
    setDraft((prev) => updater(prev));
  };

  const updateSelect = (key, value) => {
    updateDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (disabled || saving || typeof onSave !== 'function') return;
    beginChange();
    setSaving(true);
    try {
      await onSave(buildPayload(draft));
      setSaved(true);
      setDirty(false);
    } catch (caught) {
      setSaveError(caught?.message ?? '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  const busy = disabled || saving;
  const note = capabilityNote(capability);

  // Whether the save button should say "清除覆盖" (payload is null and
  // an override exists) vs "保存" (payload is non-null).
  const hasOverride = countOverrides(humanize) > 0;
  const draftHasCustom = SCALAR_HUMANIZE_FIELDS.some((field) => draft[field.key] !== '');

  return h('div', { className: 'dim-sendDelayEditor' },
    h('button', {
      type: 'button',
      className: 'dim-sendDelayToggle',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
      disabled,
    },
    h('span', { className: 'dim-sendDelayToggleLabel' }, '拟人化'),
    h('span', {
      className: 'dim-sendDelayToggleStatus',
      'data-active': hasOverride,
    }, overrideLabel(humanize)),
    h('span', { className: 'dim-sendDelayChevron', 'aria-hidden': 'true' }, open ? '▾' : '▸')),
    open ? h('div', { className: 'dim-sendDelayBody' },

      // ── Scalar settings (tri-state dropdown: 跟随全局 / explicit) ───
      ...SCALAR_HUMANIZE_FIELDS.map((field) => h(
        'label',
        { key: field.key, className: 'dim-humanizeField dim-sendDelayField' },
        h('span', { className: 'dim-humanizeFieldRow' },
          h('select', {
            value: draft[field.key],
            disabled: busy,
            'aria-label': field.label,
            onChange: (event) => updateSelect(field.key, event.target.value),
          },
          h('option', { value: '' },
            `跟随全局 (${inheritedLabel(field, defaults[field.key])})`),
          fieldOptions(field).map((option) =>
            h('option', { key: option.value, value: option.value }, option.label))),
          h('span', { className: 'dim-humanizeFieldName' }, field.label)),
        h('span', { className: 'dim-humanizeFieldHint' }, field.hint),
      )),

      note ? h('p', { className: 'dim-humanizeFieldHint dim-sendDelayNote' }, note) : null,

      // ── Save ──────────────────────────────────────────────────────
      h('div', { className: 'dim-humanizeActions' },
        h('button', {
          type: 'button',
          className: 'dim-deliveryButton dim-humanizeSave',
          'data-kind': 'primary',
          disabled: busy || (!dirty && !hasOverride),
          onClick: () => { void save(); },
        }, saving ? '保存中…' : (!draftHasCustom && hasOverride ? '清除覆盖' : '保存')),
        saved
          ? h('span', { className: 'dim-humanizeStatus', 'data-tone': 'success', role: 'status' }, '已保存')
          : null,
        saveError
          ? h('span', { className: 'dim-humanizeStatus', 'data-tone': 'error', role: 'alert' }, saveError)
          : null))
      : null);
}

/**
 * Deprecated alias for backward compatibility. New mount sites should
 * use BotHumanizeEditor with the `humanizeDefaults` prop (full global
 * settings object). This adapter accepts the old `sendDelayDefaults`
 * prop and projects it as `{ sendDelay }`.
 */
export function BotSendDelayEditor(props) {
  return h(BotHumanizeEditor, {
    ...props,
    humanizeDefaults: props.humanizeDefaults
      ?? (props.sendDelayDefaults ? { sendDelay: props.sendDelayDefaults } : null),
  });
}
