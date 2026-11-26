import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'proactive-im-delivery-'));
const outfile = join(directory, 'proactive-test.mjs');
const { analyzeWakeTurn, FRAMING_MARKER, PROACTIVE_SOURCE_KIND, WakeDriver, DEFAULT_CONFIG } = await (async () => {
  try {
    await build({
      stdin: {
        contents: [
          'export { analyzeWakeTurn } from "./observer.ts";',
          'export { FRAMING_MARKER, PROACTIVE_SOURCE_KIND } from "./framing.ts";',
          'export { WakeDriver } from "./wake.ts";',
          'export { DEFAULT_CONFIG } from "./config.ts";',
        ].join('\n'),
        resolveDir: fileURLToPath(new URL('../vendor/proactive/src/', import.meta.url)),
      },
      bundle: true, platform: 'node', format: 'esm', outfile,
      plugins: [{
        name: 'host-externals',
        setup(builder) {
          builder.onResolve({ filter: /^@deepseek-ai\// }, ({ path }) => ({
            path: import.meta.resolve(path), external: true,
          }));
        },
      }],
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

const start = { type: 'turn/start', data: {} };
const wake = { type: 'user/message', data: {
  source: { kind: PROACTIVE_SOURCE_KIND }, content: [{ type: 'text', text: FRAMING_MARKER + ' test alarm' }],
} };
const user = { type: 'user/message', data: { source: { kind: 'user' } } };
const assistant = (text) => ({ type: 'assistant/message', data: { text } });
const tool = (name, type = 'tool/call') => ({ type, data: { name } });
const end = (kind) => ({ type: 'turn/end', data: { reason: { kind } } });

test('a completed wake forwards the full final answer from its own framed turn', () => {
  const final = 'wake reply '.repeat(50).trim();
  const actual = analyzeWakeTurn([
    start, wake, assistant('A pre-tool progress message'), tool('read'), assistant(final), end('completed'),
    start, user, assistant('A subsequent conversation'), end('completed'),
  ], 0);
  assert.equal(actual.decision, 'reply');
  assert.equal(actual.deliveryText, final);
  assert.ok(actual.replySummary.length < final.length);
});

test('an explicit tool send, silence, failed or steered wake does not auto-forward', () => {
  for (const step of [tool('send_im'), tool('send_im', 'tool/code-dispatch-start'),
    tool('no_reply'), tool('proactive_reclaim'), user]) {
    assert.equal(analyzeWakeTurn([start, wake, step, assistant('Text'), end('completed')], 0).deliveryText, undefined);
  }
  assert.equal(analyzeWakeTurn([start, wake, assistant('Partial'), end('aborted')], 0).deliveryText, undefined);
  assert.equal(analyzeWakeTurn([start, user, assistant('Unrelated'), end('completed')], 0).deliveryText, undefined);
});

test('the scheduler driver forwards one settled answer and records delivery failure without re-running the alarm', async () => {
  const events = [];
  const session = { events, get seq() { return events.length; } };
  let wakeCount = 0;
  const agent = {
    session,
    async runMaintenance(job) { return job(); },
    followup(message) {
      wakeCount++;
      events.push(start, { type: 'user/message', data: message });
    },
    async whenIdle() {
      events.push(assistant('正文'), end('completed'));
    },
  };
  const delivered = [];
  let fail = false;
  const driver = new WakeDriver({
    agents: { get: () => agent },
    config: DEFAULT_CONFIG,
    log() {},
    async deliverReply(sessionId, text) {
      assert.equal(sessionId, 'main');
      if (fail) throw new Error('simulated provider failure');
      delivered.push(text);
      return 'IM delivered';
    },
  });
  const alarm = { id: 'alarm', type: 'once', prompt: '通知我', timeZone: 'UTC', target: { mode: 'resume', sessionId: 'main' } };
  const success = await driver.fire(alarm);
  assert.equal(success.outcome, 'ok');
  assert.equal(success.analysis.note, 'IM delivered');
  assert.deepEqual(delivered, ['正文']);

  fail = true;
  const failedDelivery = await driver.fire(alarm);
  assert.equal(failedDelivery.outcome, 'ok');
  assert.equal(failedDelivery.analysis.note, 'IM delivery failed');
  assert.equal(wakeCount, 2);
});
