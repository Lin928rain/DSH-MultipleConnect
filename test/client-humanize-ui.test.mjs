import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import { HumanizeSettingsPanel } from '../plugin-src/client/humanize-settings.js';
import {
  BotHumanizeEditor,
  TYPING_CAPABILITY,
} from '../plugin-src/client/channels/shared/bot-send-delay.js';
import { createTokenChannelApi } from '../plugin-src/client/channels/shared/token-api.js';
import { DEFAULT_SEND_DELAY_CONFIG } from '../src/channels/shared/send-delay.mjs';
import { DEFAULT_HUMANIZE_SETTINGS } from '../src/channels/shared/humanize-settings.mjs';

const { act, create } = TestRenderer;

function baseSettings() {
  return JSON.parse(JSON.stringify({
    ...DEFAULT_HUMANIZE_SETTINGS,
    sendDelay: { ...DEFAULT_SEND_DELAY_CONFIG },
  }));
}

async function renderPanel(rpcCall) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(HumanizeSettingsPanel, { rpcCall }));
  });
  return renderer;
}

function findByInputLabel(renderer, label) {
  return renderer.root.findAll((node) => Boolean(node.props))
    .filter((node) => node.props['aria-label'] === label)[0];
}

function allText(renderer) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(renderer.toJSON());
  return out.join('');
}

test('humanize panel omits random wait settings and saves supported fields', async () => {
  const settings = baseSettings();
  settings.sendDelay.readDelay = { minMs: 1000, maxMs: 6000 };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'humanize.get') return { ok: true, value: settings };
    return { ok: true, value: settings };
  };
  const renderer = await renderPanel(rpcCall);

  assert.equal(renderer.root.findAllByType('input').some((input) => input.props.type === 'number'), false);
  const typingSelect = renderer.root.findAllByType('select').find((select) =>
    select.props.children.some((item) => item.props.value === 'continuous'));
  assert.deepEqual(typingSelect.props.children.map((option) => option.props.value), ['off', 'continuous']);
  const toggle = renderer.root.findAllByType('input').find((input) => input.props.type === 'checkbox');
  await act(async () => toggle.props.onChange({ target: { checked: false } }));
  await act(async () => renderer.root.findByProps({ 'data-kind': 'primary' }).props.onClick());
  const { payload } = calls.find((call) => call.endpoint === 'humanize.set');
  assert.equal(payload.sendDelay, undefined);
  assert.equal(payload.typingBurst, undefined);
});


test('BotHumanizeEditor per-key save only includes custom keys', async () => {
  const saved = [];
  const humanize = {
    typingIndicator: 'off',
    statusReaction: false,
    replyQuote: false,
    sendDelay: {
      enabled: true,
      readDelay: {
        minMs: 3000,
        maxMs: 4000,
        charsPerSecond: 10,
        maxTotalMs: 30000,
        activityBoost: { enabled: false, fastReplyMs: 1000, fastWindowMs: 60000, minWindowMs: 120000, fullWindowMs: 300000 },
      },
      segmentGap: { minMs: 500, maxMs: 1000, charsPerSecond: 0, maxTotalMs: 10000 },
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(BotHumanizeEditor, {
      humanize,
      onSave: async (value) => { saved.push(value); },
    }));
  });

  const status = renderer.root.findByProps({ className: 'dim-sendDelayToggleStatus' });
  assert.equal(status.props['data-active'], true, 'override is visible on the toggle');
  assert.ok(status.props.children.includes('3'), 'shows 3 overridden items');

  // Open the panel.
  await act(async () => { renderer.root.findByProps({ className: 'dim-sendDelayToggle' }).props.onClick(); });

  // Re-saving the sendDelay keeps only sendDelay (per-key: typingIndicator
  // etc. are custom but unchanged, so they ride along).
  const streaming = renderer.root.findAllByType('select')[0];
  await act(async () => streaming.props.onChange({ target: { value: 'false' } }));
  await act(async () => {
    await renderer.root.findByProps({ 'data-kind': 'primary' }).props.onClick();
  });
  assert.equal(saved.length, 1);
  // All 4 custom keys are saved (they were custom and unchanged).
  assert.equal(saved[0].typingIndicator, 'off');
  assert.equal(saved[0].statusReaction, false, 'custom key survives the save');
  assert.equal(saved[0].replyQuote, false, 'custom key survives the save');
  assert.equal(saved[0].sendDelay, undefined);

  // After save, re-render with the saved humanize so the editor re-syncs.
  await act(async () => {
    renderer.update(React.createElement(BotHumanizeEditor, {
      humanize: saved[0],
      onSave: async (value) => { saved.push(value); },
    }));
  });

  // Switch typingIndicator back to follow-global (empty value): saving
  // drops that key, keeping the others.
  const typingSelect = renderer.root.findAll((node) =>
    node.props?.['aria-label'] === '输入状态指示')[0];
  await act(async () => { typingSelect.props.onChange({ target: { value: '' } }); });
  await act(async () => {
    await renderer.root.findByProps({ 'data-kind': 'primary' }).props.onClick();
  });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].typingIndicator, undefined, 'un-customized key is dropped');
  assert.equal(saved[1].statusReaction, false, 'still-customized key survives');
  assert.equal(saved[1].streaming, false, 'streaming override survives');

  // Clear all custom → save null.
  // Set all selects to '' and uncheck custom checkboxes.
  const streamingSelect = renderer.root.findAll((node) =>
    node.props?.['aria-label'] === '流式回复')[0];
  await act(async () => { streamingSelect.props.onChange({ target: { value: '' } }); });
  // statusReaction and replyQuote selects
  const reactionSelect = renderer.root.findAll((node) =>
    node.props?.['aria-label'] === '状态表情回应')[0];
  await act(async () => { reactionSelect.props.onChange({ target: { value: '' } }); });
  const quoteSelect = renderer.root.findAll((node) =>
    node.props?.['aria-label'] === '回复引用')[0];
  await act(async () => { quoteSelect.props.onChange({ target: { value: '' } }); });
  // Message handling has no per-bot switch any more: it is one global mode.
  const typingSel = renderer.root.findAll((node) =>
    node.props?.['aria-label'] === '输入状态指示')[0];
  await act(async () => { typingSel.props.onChange({ target: { value: '' } }); });

  await act(async () => {
    await renderer.root.findByProps({ 'data-kind': 'primary' }).props.onClick();
  });
  assert.equal(saved.length, 3);
  assert.equal(saved[2], null, 'all-follow-global saves null and clears the override');
});


test('BotHumanizeEditor surfaces the no-typing capability note', async () => {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(BotHumanizeEditor, {
      humanize: null,
      capability: TYPING_CAPABILITY.none,
      onSave: async () => {},
    }));
  });
  await act(async () => { renderer.root.findByProps({ className: 'dim-sendDelayToggle' }).props.onClick(); });
  assert.ok(allText(renderer).includes('没有输入状态接口'),
    'the no-typing note renders');
});

test('token channel snapshot normalization carries per-bot humanize through', () => {
  const api = createTokenChannelApi('Telegram', ' Bot API 长轮询');
  const snapshot = {
    revision: 3,
    bots: [{
      botId: 'tg-1',
      connected: true,
      state: 'connected',
      bot: { name: 'Bot', username: 'test_bot' },
      health: { summary: 'ok' },
      humanize: {
        typingIndicator: 'off',
        sendDelay: {
          enabled: true,
          readDelay: { minMs: 1000, maxMs: 2000 },
          segmentGap: { minMs: 200, maxMs: 800 },
        },
      },
    }],
  };
  const normalized = api.normalizeSnapshot({ snapshot });
  assert.equal(normalized.bots[0].humanize.typingIndicator, 'off');
  assert.equal(normalized.bots[0].humanize.sendDelay.readDelay.maxMs, 2000);
  // The resolved global humanize defaults ride along at snapshot level for
  // the per-bot editor prefill (now the full settings object).
  const withDefaults = api.normalizeSnapshot({
    snapshot: {
      ...snapshot,
      humanizeDefaults: { sendDelay: { enabled: true, readDelay: { minMs: 30000 } } },
    },
  });
  assert.ok(withDefaults.humanizeDefaults, 'full defaults pass through');
  assert.equal(withDefaults.humanizeDefaults.sendDelay.readDelay.minMs, 30000);
  assert.equal(api.normalizeSnapshot({ snapshot }).humanizeDefaults, undefined,
    'absent defaults stay absent');
  // Malformed overrides are leniently repaired (disk repair contract):
  // an invalid enabled flag drops and the rest fills with defaults.
  const broken = api.normalizeSnapshot({
    snapshot: {
      revision: 3,
      bots: [{
        botId: 'tg-2', connected: true, state: 'connected',
        bot: { name: 'Bot' }, health: { summary: 'ok' },
        humanize: { sendDelay: { enabled: 'yes please' }, streaming: 42 },
      }],
    },
  });
  assert.equal(broken.bots[0].humanize.sendDelay.enabled, false);
  assert.equal(broken.bots[0].humanize.streaming, undefined);
});

test('BotHumanizeEditor keeps unsaved drafts across snapshot refreshes', async () => {
  const saved = [];
  const makeHumanize = () => ({ streaming: true });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(BotHumanizeEditor, {
      humanize: makeHumanize(),
      onSave: async (value) => { saved.push(value); },
    }));
  });
  await act(async () => { renderer.root.findByProps({ className: 'dim-sendDelayToggle' }).props.onClick(); });

  // Simulate an unsaved edit followed by a 15s silent poll that rebuilds
  // the snapshot object (fresh identity, same values): the draft must win.
  const readMin = renderer.root.findAllByType('select')[0];
  await act(async () => { readMin.props.onChange({ target: { value: 'false' } }); });
  await act(async () => {
    renderer.update(React.createElement(BotHumanizeEditor, {
      humanize: makeHumanize(),
      onSave: async (value) => { saved.push(value); },
    }));
  });
  const afterPoll = renderer.root.findAllByType('select')[0];
  assert.equal(afterPoll.props.value, 'false', 'a mounted editor owns its draft');

  // After a successful save the editor re-syncs from the fresh snapshot.
  await act(async () => {
    await renderer.root.findByProps({ 'data-kind': 'primary' }).props.onClick();
  });
  assert.equal(saved.length, 1);
  await act(async () => {
    renderer.update(React.createElement(BotHumanizeEditor, {
      humanize: null,
      onSave: async (value) => { saved.push(value); },
    }));
  });
  assert.equal(renderer.root.findByProps({ className: 'dim-sendDelayToggleStatus' }).props.children,
    '跟随全局', 'clean editor follows the refreshed snapshot');
});
