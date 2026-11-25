import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IM_SEND_TOOL,
  createImSendToolDefinition,
  installImSendTool,
} from '../src/channels/shared/im-send-tool.mjs';

test('send_im delivers through an explicit botId + targetId and reports success', async () => {
  const calls = [];
  const definition = createImSendToolDefinition({
    send: async (botId, targetId, text, options) => {
      calls.push({ botId, targetId, text, options });
    },
  });
  const signal = AbortSignal.timeout(1000);

  const result = await definition.execute(
    { botId: 'bot-a', targetId: 'daily-report', text: '构建已完成。' },
    { signal },
  );

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { botId: calls[0].botId, targetId: calls[0].targetId, text: calls[0].text },
    { botId: 'bot-a', targetId: 'daily-report', text: '构建已完成。' },
  );
  assert.equal(calls[0].options?.signal, signal);
});

test('send_im surfaces delivery errors with their public code', async () => {
  const failure = Object.assign(new Error('The bot is offline'), { code: 'bot-not-connected' });
  const definition = createImSendToolDefinition({
    send: async () => { throw failure; },
  });

  await assert.rejects(
    definition.execute({ botId: 'bot-a', targetId: 'daily-report', text: 'hi' }, {}),
    /send_im failed \(bot-not-connected\): The bot is offline/,
  );
});

test('send_im rejects a half-specified explicit target', async () => {
  const definition = createImSendToolDefinition({ send: async () => {} });

  await assert.rejects(
    definition.execute({ botId: 'bot-a', text: 'hi' }, {}),
    /send_im failed \(bad-request\): botId, targetId and text are required/,
  );
});

test('installImSendTool registers the tool and the prompt section, or refuses cleanly', () => {
  const registered = [];
  const sections = [];
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section: (section) => sections.push(section) },
  };
  const send = async () => {};

  assert.equal(installImSendTool(ctx, { send }), true);
  assert.equal(registered[0].name, IM_SEND_TOOL);
  assert.deepEqual(registered[0].parameters.required, ['botId', 'targetId', 'text']);
  assert.equal(sections[0].name, 'dsh-multiple-connect:send-im');
  assert.match(sections[0].text, /originating IM chat receives it automatically/);

  assert.equal(installImSendTool({}, { send }), false);
  assert.equal(installImSendTool(ctx, {}), false);
  assert.throws(() => createImSendToolDefinition({}), TypeError);
});