import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerManagementRpc } from '../management-rpc.mjs';
import { resolveRpcAuthority } from './rpc-authority.mjs';
import { ConnectStore } from './connect-store.mjs';
import { InboxStorage, readInboxLayout } from './inbox-storage.mjs';
import { inboxAttachments, inboxReply } from '../../src/channels/shared/multiple-connect.mjs';

export const CONNECT_RPC = '/dsh-multiple-connect';

export function connectDataDirectory(config) {
  const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return config.multipleConnect?.dataDir ?? join(home, 'multiple-connect');
}

export class MainConversation {
  #ensuring;
  #turn = Promise.resolve();

  constructor(store, host) {
    this.store = store;
    this.host = host;
  }

  current() {
    const entry = this.store.getState('main');
    return entry?.ready && this.host.available(entry) ? entry : undefined;
  }

  ensure() {
    if (!this.#ensuring) {
      this.#ensuring = this.#reconcile().finally(() => { this.#ensuring = undefined; });
    }
    return this.#ensuring;
  }

  async #reconcile() {
    const selected = this.store.getState('workspace');
    const workspace = await this.host.workspace(selected);
    if (!workspace || this.store.getState('workspace') !== selected) return undefined;
    let entry = this.store.getState('main');
    if (entry?.workspaceId !== workspace.workspaceId || !this.host.available(entry)) {
      const sessionId = await this.host.create(workspace.workspaceId);
      entry = { sessionId, workspaceId: workspace.workspaceId, ready: false };
      this.store.setState('main', entry);
    }
    if (!entry.ready) {
      await this.host.initialize(entry.sessionId);
      entry = { ...entry, ready: true };
      this.store.setState('main', entry);
    }
    return this.current();
  }

  run(work, signal) {
    const turn = this.#turn.then(async () => {
      signal?.throwIfAborted();
      const entry = await this.ensure();
      if (!entry) {
        const error = new Error('Choose a default workspace in DSH-MultipleConnect settings.');
        error.code = 'main-workspace-unavailable';
        throw error;
      }
      signal?.throwIfAborted();
      return work(entry);
    });
    this.#turn = turn.catch(() => undefined);
    return turn;
  }
}

function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name, false) : ctx[name];
}

export function createDshMainHost(ctx) {
  const host = {
    async workspace(selected) {
      const registry = service(ctx, 'workspaceRegistry');
      if (selected) {
        const workspace = registry?.get(selected);
        return workspace && { workspaceId: String(workspace.id) };
      }
      const result = await ctx.workspaceController.initializeDefault(AbortSignal.timeout(15_000));
      return result?.workspace;
    },
    available({ workspaceId, sessionId }) {
      const registry = service(ctx, 'workspaceRegistry');
      return registry?.get(workspaceId)?.sessionIds.includes(sessionId) === true
        && !registry.archivedSessionIds.includes(sessionId);
    },
    async create(workspaceId) {
      const { sessionId } = await ctx.sessionController.create({ workspaceId });
      return sessionId;
    },
    async initialize(sessionId) {
      const agent = service(ctx, 'agents')?.get(sessionId);
      const permissions = service(ctx, 'permissionPresets');
      if (!agent?.session || !permissions?.set) throw new Error('DSH session permission service is unavailable');
      permissions.set(agent.session, 'danger-full-access');
      await ctx.sessionController.rename({ sessionId, title: '主对话' });
    },
    notify(entry, requestId, text) {
      return ctx.sessionController.prompt({
        sessionId: entry.sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000));
    },
  };
  return host;
}

export function createMultipleConnect(ctx, config, deliveryService, {
  store,
  host = createDshMainHost(ctx),
  logger = console,
} = {}) {
  const home = connectDataDirectory(config);
  const { configured, ...layout } = readInboxLayout(home);
  const database = join(layout.messageDirectory, 'connections.sqlite');
  if (!store && configured && !existsSync(database)) {
    throw Object.assign(new Error('The configured message database is unavailable. Restore access and restart the Host. ' + database),
      { code: 'inbox-storage-offline' });
  }
  store ??= new ConnectStore(database);
  const storage = new InboxStorage(home, store, layout);
  const providers = new Map();
  const recentPreviews = new Map();
  let previewCount = 0;
  const main = new MainConversation(store, host);
  let instanceId = store.getState('instance');
  if (!instanceId) {
    instanceId = randomUUID();
    store.setState('instance', instanceId);
  }
  let pending;
  let stopped = false;

  function kick() {
    if (stopped || pending) return pending;
    pending = (async () => {
      const active = await main.ensure();
      if (!active || stopped) return;
      for (let notice; !stopped && (notice = store.nextNotification());) {
        const entry = main.current();
        if (!entry) break;
        const bot = (await deliveryService.listBots()).find(({ botId }) => botId === notice.botId);
        const name = store.getState('snowluma.connections')?.find(({ botId }) => botId === notice.botId)?.name
          ?? (bot ? `${bot.channel} · ${bot.botId}` : notice.botId);
        if (stopped) break;
        if (store.nextNotification()?.id !== notice.id) continue;
        await host.notify(entry, `multiple-connect-${instanceId}-${notice.id}`,
          `[DSH-MultipleConnect] ${name} 收到 ${notice.count} 条新消息。`);
        store.finishNotification(notice.id);
      }
    })().catch((error) => logger.warn?.('[dsh-multiple-connect] main or notification pending:', error?.message ?? error))
      .finally(() => { pending = undefined; });
    return pending;
  }

  const timer = setInterval(() => { void kick(); void storage.sweep(); }, 10_000);
  timer.unref?.();
  const unwatch = ctx.on?.('domain/changed', (change) => {
    if (change?.domain === 'workspace' || change?.domainName === 'workspace') void kick();
  }, { global: true });
  // Channel startup must never wait for a model selection, a workspace, or an
  // inbox backlog. Both ingestion and the startup timer can wake reconciliation.
  void kick();

  const api = {
    main, store, storage, kick,
    provider: (botId) => providers.get(botId),
    connection(botId, harness) {
      return {
        botId,
        harness,
        main,
        activeTurns: new Map(),
        mode: () => store.settings(botId).mode,
        recall: ({ messageId, chatId }) => store.recall(botId, messageId, chatId),
        bindInboxProvider(provider) {
          providers.set(botId, provider);
          return () => { if (providers.get(botId) === provider) providers.delete(botId); };
        },
        receive(message) {
          const saved = {
            ...message, attachments: inboxAttachments(message.attachments), replyTo: inboxReply(message.replyTo),
          };
          const mode = store.receive(botId, saved);
          const provider = providers.get(botId);
          const scope = [botId, saved.conversationId, saved.messageId, undefined];
          const key = JSON.stringify(scope);
          if (mode !== 'silent' && !stopped && provider?.open && previewCount < 8
            && saved.attachments.some((item) => item.preview && item.source)
            && Date.now() - (recentPreviews.get(key) ?? 0) > 60_000) {
            recentPreviews.set(key, Date.now());
            if (recentPreviews.size > 512) recentPreviews.delete(recentPreviews.keys().next().value);
            const authorize = () => {
              const current = store.message(...scope.slice(0, 3));
              return providers.get(botId) === provider && current && !current.details.deleted
                && !current.details.updatedAt && (!provider.authorize || provider.authorize(saved.conversationId));
            };
            for (const item of saved.attachments.filter((item) => item.preview && item.source).slice(0, Math.min(4, 8 - previewCount))) {
              previewCount += 1;
              void storage.download(scope, item, (limits) => provider.open(item.source, limits), { preview: true, authorize })
                .catch(() => undefined).finally(() => { previewCount -= 1; });
            }
          }
          if (mode === 'notify') void kick();
          return mode;
        },
      };
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      unwatch?.();
      await pending;
      await storage.close();
      store.close();
    },
  };
  return api;
}

export function installConnectRpc(ctx, runtime, deliveryService, config, snowluma) {
  return registerManagementRpc(ctx, CONNECT_RPC, async (endpoint, payload = {}, signal) => {
    try {
      if (endpoint === 'status') {
        const bots = await deliveryService.listBots();
        return { ok: true, value: {
          main: runtime.main.current(),
          workspaces: service(ctx, 'workspaceRegistry')?.list().map(({ id, title, path }) => ({
            workspaceId: String(id), title, path,
          })) ?? [],
          bots: bots.map((bot) => ({ ...bot, settings: runtime.store.settings(bot.botId) })),
          snowluma: snowluma.list(),
          storage: await runtime.storage.status(),
        } };
      }
      if (endpoint === 'storage.set') return { ok: true, value: await runtime.storage.configure(payload) };
      if (endpoint === 'storage.approve') return { ok: true, value: runtime.storage.approve(payload.id) };
      if (endpoint === 'connection.set') {
        const bots = await deliveryService.listBots();
        if (!bots.some(({ botId }) => botId === payload.botId)) throw new Error('Unknown connection');
        return { ok: true, value: runtime.store.configure(payload.botId, payload.settings) };
      }
      if (endpoint === 'main.archive') {
        const main = runtime.main.current();
        if (!main || payload.sessionId !== main.sessionId) throw new Error('The main conversation has already changed');
        await ctx.workspaceController.archiveSession({ sessionId: main.sessionId });
        return { ok: true, value: await runtime.main.ensure() };
      }
      if (endpoint === 'workspace.set') {
        const workspaceId = payload.workspaceId;
        if (!service(ctx, 'workspaceRegistry')?.get(workspaceId)) throw new Error('Unknown workspace');
        if (runtime.main.current()) throw new Error('The main conversation already has a workspace');
        runtime.store.setState('workspace', workspaceId);
        return { ok: true, value: await runtime.main.ensure() };
      }
      if (endpoint === 'snowluma.set') return { ok: true, value: await snowluma.configure(payload) };
      if (endpoint === 'snowluma.delete') return { ok: true, value: await snowluma.remove(payload.botId) };
      throw new Error('Unknown settings operation');
    } catch (error) {
      return { ok: false, error: { code: 'multiple-connect-settings', message: error.message } };
    }
  }, { authority: resolveRpcAuthority(config.rpcAuthority) });
}

export function installStorageErrorRpc(ctx, config, error) {
  return registerManagementRpc(ctx, CONNECT_RPC, () => ({
    ok: false, error: { code: error.code, message: error.message },
  }), { authority: resolveRpcAuthority(config.rpcAuthority) });
}
