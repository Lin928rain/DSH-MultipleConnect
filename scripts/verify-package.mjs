import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const [host, client, patch, packageText, lockText, proactiveLicense] = await Promise.all([
  read('lib/index.js'), read('lib/client.js'), read('cordis.patch.yml'), read('package.json'),
  read('package-lock.json'), read('vendor/proactive/LICENSE'),
]);
const manifest = JSON.parse(packageText);
const lock = JSON.parse(lockText);
assert.equal(manifest.name, 'dsh-multiple-connect');
assert.equal(lock.packages[''].name, manifest.name);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.match(patch, /name:\s*dsh-multiple-connect/u);
assert.match(client, /id:\s*["']dsh-multiple-connect["']/u);
assert.match(proactiveLicense, /MIT License/u);
assert.ok(manifest.files.includes('vendor/proactive/LICENSE'));

const hostLibraries = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools'];
const { dsh: dshRange, dshReleases } = manifest.dsh.compatibility;
assert.equal(manifest.engines.dsh, dshRange);
assert.ok(semver.validRange(dshRange), 'Declare a valid Host version range');
for (const [version, status] of Object.entries(dshReleases)) {
  assert.equal(semver.satisfies(version, dshRange), status === 'compatible',
    'Host install check and compatibility table disagree for ' + version);
}
for (const name of hostLibraries) {
  assert.equal(manifest.peerDependencies[name], dshRange, 'Align shared Host peer for ' + name);
  assert.equal(lock.packages[''].peerDependencies[name], dshRange, 'Sync shared Host peer lock for ' + name);
  assert.equal(manifest.dependencies?.[name], undefined);
  assert.ok(host.includes(name), 'Keep the Host import external for ' + name);
}
for (const marker of [
  '/dsh-multiple-connect', 'send_im', 'read_im_messages', 'list_im_conversations', 'read_im_resources', 'open_im_attachment',
  'message_break', 'proactive_set', 'send_group_msg', 'send_private_msg',
]) {
  assert.ok(host.includes(marker), 'Missing host feature ' + marker);
}
for (const marker of ['/dsh-multiple-connect', 'snowluma.set', 'connection.set', '/api/dsh-proactive']) {
  assert.ok(client.includes(marker), 'Missing client feature ' + marker);
}
assert.doesNotMatch(client + host, /private-bot-token|must-be-rolled-back|DEEPSEEK_API_KEY=/u);
await import(pathToFileURL(resolve(root, 'lib/index.js')).href);
console.log('Verified DSH-MultipleConnect package artifacts.');
