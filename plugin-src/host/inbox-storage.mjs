import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, rmdir, stat, statfs, utimes } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MiB = 1024 ** 2;
const day = 86_400_000;
const assetDirectory = 'dsh-multiple-connect-assets';
const cacheName = /^[a-f0-9]{64}(?:\.[a-z0-9]{1,10})?$/;
const partialName = /^[a-f0-9]{64}(?:\.[a-z0-9]{1,10})?\.[a-f0-9-]{36}\.part$/;

export function readInboxLayout(home) {
  const defaults = {
    messageDirectory: resolve(home), attachmentDirectory: resolve(home),
    cacheMiB: 5120, downloadMiB: 128, cacheDays: 30, historyDays: 0,
  };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(home, 'storage.json'), 'utf8')), configured: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return defaults;
  }
}

function saveLayout(home, settings) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, 'storage.' + randomUUID());
  try {
    writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(home, 'storage.json'));
  } finally { rmSync(temporary, { force: true }); }
}

function directory(value) {
  if (typeof value !== 'string' || !isAbsolute(value.trim())) throw new Error('Use a full storage directory path.');
  const path = resolve(value.trim());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

function inboxError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function* boundedAttachmentBody(body, maxBytes, signal) {
  let total = 0;
  for await (const value of body) {
    signal?.throwIfAborted();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw inboxError('attachment-limit', 'Attachment exceeds the download budget.');
    yield chunk;
  }
}

export class InboxStorage {
  #tail = Promise.resolve();
  #requests = new Map();
  #shutdown = new AbortController();
  #lastSweep = 0;
  #warning;

  constructor(home, store, settings) {
    this.home = home;
    this.store = store;
    this.settings = settings;
  }

  get root() { return join(this.settings.attachmentDirectory, assetDirectory); }

  #serialize(task) {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #files(root, { create = false } = {}) {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!info) return [];
    if (!info.isDirectory()) throw new Error('The attachment cache must be a regular directory.');
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
      if (!create && error.code === 'ENOENT') return [];
      throw error;
    });
    return (await Promise.all(entries.filter((entry) => entry.isFile() && cacheName.test(entry.name))
      .map(async ({ name }) => {
        const path = join(root, name);
        const info = await stat(path, { throwIfNoEntry: false }).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        return info && { path, size: info.size, used: info.mtimeMs };
      }))).filter(Boolean);
  }

  async status() {
    try {
      await stat(this.settings.attachmentDirectory);
      if (this.store.path !== ':memory:') await stat(this.store.path);
      const cacheBytes = (await this.#files(this.root)).reduce((sum, file) => sum + file.size, 0);
      return { ...this.settings, databaseBytes: this.store.size(), cacheBytes,
        requests: [...this.#requests.values()].filter((item) => item.expires > Date.now())
          .map(({ id, name, size, approved }) => ({ id, name, size, approved })),
        warning: this.#warning };
    } catch {
      return { ...this.settings, warning: 'The configured storage directory is unavailable.' };
    }
  }

  configure(value) {
    return this.#serialize(async () => {
      const before = this.settings;
      const next = { ...before };
      for (const [key, minimum] of Object.entries({ cacheMiB: 1, downloadMiB: 1, cacheDays: 1, historyDays: 0 })) {
        if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > 1_048_576) {
          throw new Error('Invalid storage limit.');
        }
        next[key] = value[key];
      }
      if (next.downloadMiB > next.cacheMiB) throw new Error('The single-file limit must fit inside the cache quota.');
      next.messageDirectory = directory(value.messageDirectory);
      next.attachmentDirectory = directory(value.attachmentDirectory);
      const oldRoot = this.root;
      const nextRoot = join(next.attachmentDirectory, assetDirectory);
      const previousDatabase = this.store.path;
      const nextDatabase = join(next.messageDirectory, 'connections.sqlite');
      if (within(nextRoot, next.messageDirectory) || within(oldRoot, next.messageDirectory)) {
        throw new Error('Keep the message database outside the attachment cache.');
      }
      let copied = false;
      let files = [];
      if (nextRoot !== oldRoot) {
        if (within(oldRoot, nextRoot) || within(nextRoot, oldRoot)) throw new Error('Select a separate cache directory.');
        await stat(before.attachmentDirectory);
        files = await this.#files(oldRoot);
        const temporary = nextRoot + '.' + randomUUID();
        const existing = await lstat(nextRoot).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (existing && (!existing.isDirectory() || (await readdir(nextRoot)).length)) {
          throw new Error('The destination already contains an attachment cache.');
        }
        if (files.length) {
          try {
            await mkdir(temporary, { mode: 0o700 });
            for (const { path, size } of files) {
              const destination = join(temporary, relative(oldRoot, path));
              await cp(path, destination, { preserveTimestamps: true, force: false, errorOnExist: true });
              if ((await stat(destination)).size !== size) throw new Error('Attachment cache copy failed validation.');
            }
            if (existing) await rmdir(nextRoot);
            await rename(temporary, nextRoot);
            copied = true;
          } finally { await rm(temporary, { recursive: true, force: true }); }
        }
      }
      try {
        this.store.relocate(nextDatabase, () => saveLayout(this.home, next));
      } catch (error) {
        if (copied) await rm(nextRoot, { recursive: true, force: true });
        throw error;
      }
      this.settings = next;
      this.#lastSweep = 0;
      if (value.removePrevious === true) {
        const oldFiles = files.map(({ path }) => path);
        if (previousDatabase !== nextDatabase && previousDatabase !== ':memory:') {
          for (const suffix of ['', '-wal', '-shm']) oldFiles.push(previousDatabase + suffix);
        }
        const results = await Promise.allSettled(oldFiles.map((path) => rm(path, { force: true })));
        if (results.some(({ status }) => status === 'rejected')) this.#warning = 'Some previous storage files could not be removed.';
      }
      return this.status();
    });
  }

  approve(id) {
    const request = this.#requests.get(id);
    if (!request || request.expires < Date.now()) throw new Error('The request has expired.');
    request.approved = true;
  }

  sweep() {
    if (Date.now() - this.#lastSweep < 3_600_000) return;
    this.#lastSweep = Date.now();
    return this.#serialize(async () => {
      await stat(this.settings.attachmentDirectory);
      const names = await readdir(this.root).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      });
      for (const name of names) if (partialName.test(name)) await rm(join(this.root, name), { force: true });
      await this.#evict(0);
      this.store.pruneMessages(this.settings.historyDays ? Date.now() - this.settings.historyDays * day : 0);
      this.#warning = undefined;
    }).catch(() => { this.#warning = 'Storage maintenance could not access the configured directories.'; });
  }

  async #evict(reserve, keep) {
    const { cacheMiB, cacheDays } = this.settings;
    const files = (await this.#files(this.root)).sort((a, b) => a.used - b.used);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.path === keep) continue;
      if (Date.now() - file.used <= cacheDays * day && total + reserve <= cacheMiB * MiB) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }

  download(scope, asset, open, { signal, authorize, preview = false } = {}) {
    if (this.#shutdown.signal.aborted) return Promise.reject(this.#shutdown.signal.reason);
    return this.#serialize(async () => {
      signal?.throwIfAborted();
      if (authorize && !await authorize()) throw inboxError('attachment-unavailable', 'The message attachment is no longer available.');
      const { downloadMiB, cacheMiB } = this.settings;
      const downloader = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(3_600_000), ...(signal ? [signal] : [])]);
      const id = createHash('sha256').update(JSON.stringify([scope, asset.id, asset.source])).digest('hex');
      const extension = /\.[a-z0-9]{1,10}$/i.exec(asset.name ?? '')?.[0]?.toLowerCase() ?? '';
      const filename = id + extension;
      await stat(this.settings.attachmentDirectory);
      await this.#evict(0);
      const path = join(this.root, filename);
      const cached = (await this.#files(this.root)).find((file) => file.path === path);
      if (cached) {
        const now = new Date();
        await utimes(path, now, now);
        return { status: 'cached', path, size: cached.size };
      }
      if (asset.size > cacheMiB * MiB) return { status: 'cache-quota', size: asset.size };
      let maxBytes = Math.min(downloadMiB * MiB, preview ? 2 * MiB : Infinity);
      if (preview && asset.size > maxBytes) return { status: 'preview-limit' };
      if (asset.size > maxBytes) {
        for (const [key, request] of this.#requests) if (request.expires < Date.now()) this.#requests.delete(key);
        const request = this.#requests.get(id);
        if (!request?.approved) {
          if (this.#requests.size >= 100 && !request) this.#requests.delete(this.#requests.keys().next().value);
          if (!request) this.#requests.set(id, { id, name: asset.name, size: asset.size, expires: Date.now() + 3_600_000 });
          return { status: 'approval-required', size: asset.size, requestId: id };
        }
        maxBytes = asset.size;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.root)).isDirectory()) throw new Error('The attachment cache must be a regular directory.');
      const free = await statfs(this.root, { bigint: true });
      const available = free.bavail * free.bsize;
      if (available < BigInt(maxBytes + 64 * MiB)) throw inboxError('disk-space', 'There is insufficient space on the attachment drive.');
      await this.#evict(maxBytes);
      const temporary = join(this.root, filename + '.' + randomUUID() + '.part');
      const provider = new AbortController();
      const providerSignal = AbortSignal.any([downloader, provider.signal]);
      try {
        const response = await open({ signal: providerSignal, maxBytes });
        const body = response?.stream ?? response;
        try {
          if (response?.size > maxBytes) throw inboxError('attachment-limit', 'Attachment exceeds the download budget.');
          if (!body?.[Symbol.asyncIterator] || Buffer.isBuffer(body)) {
            throw inboxError('attachment-unavailable', 'The platform did not provide a streaming download.');
          }
          await pipeline(Readable.from(boundedAttachmentBody(body, maxBytes, providerSignal)),
            createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: providerSignal });
        } finally {
          if (typeof body?.destroy === 'function') body.destroy();
          else await body?.cancel?.().catch(() => undefined);
        }
        if (authorize && !await authorize()) throw inboxError('attachment-unavailable', 'The message attachment is no longer available.');
        const { size } = await stat(temporary);
        await rename(temporary, path);
        this.#requests.delete(id);
        return { status: 'downloaded', path, size };
      } finally {
        provider.abort();
        await rm(temporary, { force: true });
      }
    });
  }

  async close() {
    this.#shutdown.abort();
    await this.#tail;
  }
}
