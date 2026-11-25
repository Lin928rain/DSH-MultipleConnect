import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinHarnessBridge } from '../../../src/channels/weixin/weixin-bridge.mjs';
import { DingtalkHarnessBridge } from '../../../src/channels/dingtalk/dingtalk-bridge.mjs';
import { WecomHarnessBridge } from '../../../src/channels/wecom/wecom-bridge.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { DEFAULT_SEND_DELAY_CONFIG } from '../../../src/channels/shared/send-delay.mjs';

/**
 * Two-phase humanization smoke tests for the four standalone bridges (plan
 * docs/features/260908-humanize-send-delay-typing §346): the silent read
 * delay and the supersede semantics (a newer message during the delay
 * cancels the older turn silently). weixin runs the long delay tier (it has
 * a ticket typing indicator); dingtalk/wecom/feishu have no typing API and
 * cap the read delay at SHORT_DELAY_CAP_MS. Channel-specific typing
 * behavior lives in the per-channel suites (weixin ticket keepalive,
 * feishu cards, wecom streams).
 */

function withKeepAlive(run) {
  const keepAlive = setInterval(() => {}, 1_000);
  return run().finally(() => clearInterval(keepAlive));
}

function humanizeProvider(readDelay) {
  return {
    getSettings: () => ({
      typingIndicator: 'off',
      messageBreak: false,
      streaming: true,
      sendDelay: readDelay === null
        ? DEFAULT_SEND_DELAY_CONFIG
        : { ...DEFAULT_SEND_DELAY_CONFIG, enabled: true, readDelay },
    }),
  };
}

function stateFixture(boundKey) {
  const sessions = new Map(boundKey ? [[boundKey, 'session-x']] : []);
  const seen = new Set();
  return {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => sessions.set(key, sessionId),
    clearSession: async (key) => sessions.delete(key),
  };
}

function harnessRecording(asks) {
  return {
    sessionExists: async () => true,
    createSession: async () => 'session-x',
    ask: async (_sessionId, content) => {
      asks.push(String(content));
      return '桥接回答';
    },
  };
}

function weixinMessage(id, text) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: `context-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function dingtalkMessage(id, text) {
  return {
    msgId: id,
    msgtype: 'text',
    text: { content: text },
    conversationType: '1',
    conversationId: 'conversation-fixed',
    senderStaffId: 'staff-approved',
    senderNick: '钉钉用户',
    sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}`,
  };
}

function wecomFrame(id, text) {
  return {
    headers: { req_id: `req-${id}` },
    body: {
      msgid: id,
      chattype: 'single',
      from: { userid: 'member-1' },
      msgtype: 'text',
      text: { content: text },
    },
  };
}

function feishuEvent(id, text) {
  return {
    message: {
      message_id: id,
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  };
}

// ── weixin ────────────────────────────────────────────────────────────────

test('weixin: the typing keepalive pauses for a pending question and re-arms on resume', async () => withKeepAlive(async () => {
  const typingCalls = [];
  const marks = { beforePending: 0, whilePending: -1, afterResume: -1 };
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (_t, text) => ({ messageId: `wx-r-${typingCalls.length}` }),
      getConfig: async () => ({ typingTicket: 'ticket-1' }),
      sendTyping: async ({ status }) => { typingCalls.push(status); },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    typingKeepaliveMs: 40,
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-x',
      ask: async (_sessionId, _content, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'wx-interaction-1',
          rpcId: 'wx-rpc-1',
          sessionId: 'session-x',
          payload: {
            questions: [{
              id: 'q1',
              question: '继续吗？',
              choices: [{ id: 'yes', name: '继续' }, { id: 'no', name: '停止' }],
            }],
          },
        });
        // While pending: the keepalive timer must be paused.
        marks.beforePending = typingCalls.filter((status) => status === 1).length;
        await new Promise((resolve) => setTimeout(resolve, 130));
        marks.whilePending = typingCalls.filter((status) => status === 1).length;
        await options.onInteractionResolved({ kind: 'question', interactionId: 'wx-interaction-1' });
        // After resume: the keepalive re-arms (immediate refresh + loop).
        await new Promise((resolve) => setTimeout(resolve, 90));
        marks.afterResume = typingCalls.filter((status) => status === 1).length;
        return '互动后的回答';
      },
    },
    state: stateFixture('p2p:owner-user'),
    humanize: humanizeProvider({ minMs: 5, maxMs: 10 }),
  });
  await bridge.accept(weixinMessage('wx-pending', '互动问题'));
  assert.ok(marks.beforePending >= 1, 'the ticket typing starts before the ask');
  assert.equal(marks.whilePending, marks.beforePending,
    `no keepalive pulses while the question is pending (got ${marks.whilePending} vs ${marks.beforePending})`);
  assert.ok(marks.afterResume >= marks.whilePending + 2,
    `resume re-arms the keepalive loop (got ${marks.afterResume} vs ${marks.whilePending})`);
}));

// ── dingtalk ──────────────────────────────────────────────────────────────

test('dingtalk: message-break segments respect the 3s webhook rate floor', async () => withKeepAlive(async () => {
  const segmentTimes = new Map();
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async ({ text }) => {
        segmentTimes.set(text, Date.now());
        return { messageId: `ding-seg-${segmentTimes.size}` };
      },
      createAiCard: async () => true,
      updateAiCard: async () => true,
      finishAiCard: async () => true,
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-x',
      ask: async (_sessionId, _content, options) => {
        await options.onUpdate({ type: 'message_break', text: '第一段' });
        await options.onUpdate({ type: 'message_break', text: '第二段' });
        return '收尾';
      },
    },
    state: stateFixture('staff-approved'),
    humanize: {
      getSettings: () => ({
        typingIndicator: 'off',
        messageBreak: true,
        streaming: false,
        sendDelay: {
          ...DEFAULT_SEND_DELAY_CONFIG,
          enabled: true,
          readDelay: { minMs: 5, maxMs: 10 },
          // Deliberately below the DingTalk webhook floor: the bridge must
          // clamp the gap up to ~3s (20 messages/min rate limit).
          segmentGap: { minMs: 50, maxMs: 80 },
        },
      }),
    },
  });
  await bridge.accept(dingtalkMessage('ding-segments', '分段问题'));
  const firstAt = segmentTimes.get('第一段');
  const secondAt = segmentTimes.get('第二段');
  assert.ok(firstAt !== undefined && secondAt !== undefined,
    `both segments must be sent (got ${[...segmentTimes.keys()].join(', ')})`);
  assert.ok(secondAt - firstAt >= 2900,
    `the segment gap must respect the 3s webhook floor (waited ${secondAt - firstAt}ms)`);
  assert.ok(segmentTimes.has('收尾'), 'the remaining text completes the turn');
}));

test('dingtalk: streaming=false skips the AI card and sends one shot', async () => withKeepAlive(async () => {
  const calls = [];
  const startedAt = Date.now();
  let askAt = 0;
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async ({ text }) => { calls.push(`sendText:${text}@${Date.now() - startedAt}`); return { messageId: 'ding-off' }; },
      createAiCard: async () => { calls.push('createAiCard'); return true; },
      updateAiCard: async () => true,
      finishAiCard: async () => true,
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-x',
      ask: async () => { askAt = Date.now(); return '一次性回答'; },
    },
    state: stateFixture('staff-approved'),
    humanize: {
      getSettings: () => ({
        typingIndicator: 'off',
        messageBreak: false,
        streaming: false,
        sendDelay: {
          ...DEFAULT_SEND_DELAY_CONFIG,
          enabled: true,
          readDelay: { minMs: 120, maxMs: 180 },
        },
      }),
    },
  });
  await bridge.accept(dingtalkMessage('ding-nostream', '关闭流式问题'));
  assert.ok(askAt - startedAt < 100, 'ask must wait out the read delay');
  assert.ok(!calls.includes('createAiCard'), 'streaming=false never opens the AI card');
  const send = calls.find((c) => c.startsWith('sendText:'));
  assert.ok(send, 'the answer is delivered in one shot');
  assert.ok(send.includes('一次性回答'), 'the one-shot send carries the full answer');
}));

// ── wecom ─────────────────────────────────────────────────────────────────

test('wecom: streaming=false never opens a stream and answers via #sendImmediate', async () => withKeepAlive(async () => {
  const calls = [];
  const bridge = new WecomHarnessBridge({
    client: {
      // #sendImmediate is passive-first: a whole answer goes out as ONE
      // replyStream(..., finish=true) call (no placeholder, no updates).
      replyStream: async (_frame, _reqId, content, finish) => {
        calls.push(`replyStream:${content}:${finish ? 'finish' : 'open'}`);
        return { body: { msgid: 'wecom-2' } };
      },
      replyStreamNonBlocking: async () => { calls.push('replyStreamNonBlocking'); },
      sendMessage: async (chatId, payload) => {
        calls.push(`sendMessage:${payload?.markdown?.content ?? ''}`);
      },
    },
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-x',
      ask: async () => '企微一次性回答',
    },
    state: stateFixture('direct:member-1'),
    humanize: {
      getSettings: () => ({
        typingIndicator: 'off',
        messageBreak: false,
        streaming: false,
        sendDelay: {
          ...DEFAULT_SEND_DELAY_CONFIG,
          enabled: true,
          readDelay: { minMs: 120, maxMs: 180 },
        },
      }),
    },
  });
  await bridge.accept(wecomFrame('wecom-nostream', '关闭流式问题'));
  assert.ok(!calls.includes('replyStreamNonBlocking'),
    'streaming=false never opens the thinking placeholder');
  const streams = calls.filter((c) => c.startsWith('replyStream:'));
  assert.equal(streams.length, 1, `exactly one passive delivery (got ${streams.join(' | ')})`);
  assert.ok(streams[0].endsWith(':finish'), 'the passive delivery closes in one shot');
  assert.ok(streams[0].includes('企微一次性回答'), 'the one-shot delivery carries the full answer');
  assert.ok(!calls.some((c) => c.startsWith('sendMessage:')),
    'no chunked fallback was needed');
}));

// ── feishu ────────────────────────────────────────────────────────────────
