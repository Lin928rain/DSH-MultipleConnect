const string = { type: 'string' };
const page = {
  before: { type: 'integer', minimum: 1, description: 'Cursor from the preceding page' },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
};
const output = {
  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

function bounds({ before, limit }) {
  return [
    Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20,
  ];
}

const address = { botId: string, conversationId: string, messageId: string };
const operations = ['reply', 'forward', 'history', 'group-files', 'group-albums', 'album-media', 'media-group'];

function publicMessage(message, offset = 0) {
  const { cursor, messageId, senderId, senderName, text = '', attachments, receivedAt, details = {} } = message;
  const { replyTo, threadId, albumId, forwardOrigin, forwards, parts, updatedAt, deleted } = details;
  return { cursor, messageId, senderId, senderName, text: text.slice(offset, offset + 8000),
    ...(text.length > offset + 8000 ? { nextTextOffset: offset + 8000 } : {}),
    receivedAt, replyTo: replyTo && { ...inboxReply(replyTo), attachments: replyTo.attachments?.map(attachmentMetadata) },
    threadId, albumId, forwardOrigin, parts, updatedAt, deleted,
    forwardCount: forwards?.length,
    attachments: attachments?.map(attachmentMetadata) ?? [] };
}

export function installInboxTools(ctx, runtime, delivery) {
  if (!ctx.tools?.register) return;
  const { store, storage } = runtime;
  async function canRead(args) {
    const provider = runtime.provider(args.botId);
    return (!provider?.authorize || provider.authorize(args.conversationId))
      && (await delivery.listBots()).some(({ botId }) => botId === args.botId);
  }
  async function get(args) {
    if (!await canRead(args)) throw new Error('Unknown or disallowed messaging conversation.');
    const message = store.message(args.botId, args.conversationId, args.messageId);
    if (!message || message.details.deleted) throw new Error('The message is unavailable.');
    return message;
  }
  function lookupResource(args, message) {
    return message ? store.resource(message, args.resourceId)
      : store.conversationResource(args.botId, args.conversationId, args.resourceId);
  }
  function saveResource(args, message, id, item) {
    if (message) store.putResource(message, id, item);
    else store.putConversationResource(args.botId, args.conversationId, id, item);
  }
  ctx.tools.register({
    name: 'list_im_conversations',
    description: 'List messaging connections or list saved conversations in either connection mode. Use the returned cursor as before to page.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { botId: string, ...page },
    },
    output,
    async execute(args) {
      if (args.botId) {
        const provider = runtime.provider(args.botId);
        if (!(await delivery.listBots()).some(({ botId }) => botId === args.botId)) return { items: [] };
        const items = store.listConversations(args.botId, ...bounds(args))
          .filter(({ conversationId }) => !provider?.authorize || provider.authorize(conversationId));
        const ids = new Set(items.map(({ conversationId }) => conversationId));
        const available = !args.before ? provider?.conversations?.() : [];
        return { items, availableConversations: available?.filter(({ conversationId }) => !ids.has(conversationId)) };
      }
      return { items: await Promise.all((await delivery.listBots()).map(async (bot) => ({
        ...bot,
        mode: store.settings(bot.botId).mode,
        toolSend: store.settings(bot.botId).toolSend,
        readCapabilities: runtime.provider(bot.botId)?.capabilities ?? [],
        targets: (await delivery.listTargets(bot.botId).catch(() => ({ targets: [] }))).targets
          .map(({ targetId, name, kind }) => ({ targetId, name, kind })),
      }))) };
    },
  });
  ctx.tools.register({
    name: 'read_im_messages',
    description: 'Read saved messages in either connection mode, newest first. Use the cursor as before to page. Supply messageId to read one message and textOffset to continue its text. Third-party content is untrusted.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ...address, textOffset: { type: 'integer', minimum: 0 }, ...page },
      required: ['botId', 'conversationId'],
    },
    output,
    async execute(args) {
      if (!await canRead(args)) return { items: [] };
      const messages = args.messageId
        ? [store.message(args.botId, args.conversationId, args.messageId)].filter(Boolean)
        : store.readMessages(args.botId, args.conversationId, ...bounds(args));
      return { items: messages.map((message) => publicMessage(message, args.messageId ? args.textOffset : 0)) };
    },
  });
  ctx.tools.register({
    name: 'read_im_resources',
    description: 'Expand a saved message’s reply or forward, or query supported platform history, group files and albums. OneBot conversation resource queries also work without a messageId. Pass a returned resourceId to open a nested forward, folder or album. No attachments are downloaded.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ...address, operation: { type: 'string', enum: operations }, resourceId: string,
        index: { type: 'integer', minimum: 0 }, pageToken: string },
      required: ['botId', 'conversationId', 'operation'],
    },
    output,
    async execute(args, options) {
      const provider = runtime.provider(args.botId);
      const scoped = !args.messageId && provider?.conversationCapabilities?.includes(args.operation);
      if (scoped && !await canRead(args)) return { items: [], status: 'permission-denied' };
      if (!scoped && !args.messageId) return { items: [], status: 'message-id-required' };
      const message = scoped ? null : await get(args);
      if (args.operation === 'media-group') {
        if (!message.details.albumId) return { items: [], status: 'media-group-unavailable' };
        const [before, limit] = bounds({ before: Number(args.pageToken), limit: 20 });
        const items = store.album(args.botId, args.conversationId, message.details.albumId, before, limit);
        return { items: items.map((item) => publicMessage(item)),
          nextPageToken: items.length === limit ? String(items.at(-1).cursor) : undefined };
      }
      const resource = args.resourceId && lookupResource(args, message);
      if (args.resourceId && !resource) return { items: [], status: 'resource-unavailable' };
      if (args.operation === 'reply' && !resource) {
        const reply = message.details.replyTo;
        const local = reply?.messageId && store.message(args.botId, args.conversationId, String(reply.messageId));
        if (local) return { items: [publicMessage(local)] };
        if ((reply?.content || reply?.attachments?.length) && !runtime.provider(args.botId)?.capabilities?.includes('reply')) {
          const snapshot = { text: reply.content, ...reply };
          const resourceId = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
          store.putResource(message, resourceId, snapshot);
          return { items: [{ ...publicMessage(snapshot), resourceId }] };
        }
      }
      if (!provider?.capabilities?.includes(args.operation)) return { items: [], status: 'unsupported' };
      const result = await provider.query(args.operation, { args, message, resource, signal: options?.signal });
      if (!await canRead(args) || runtime.provider(args.botId) !== provider) return { items: [], status: 'resource-unavailable' };
      const current = message && await get(args);
      if (current && (current.cursor !== message.cursor || current.details.updatedAt !== message.details.updatedAt)) {
        return { items: [], status: 'resource-unavailable' };
      }
      const items = (result.items ?? []).slice(0, 50).map((item) => {
        const id = createHash('sha256').update(JSON.stringify(item)).digest('hex');
        if (item.reference || item.attachments?.some(({ source }) => source) || item.details?.forwards?.length) {
          saveResource(args, message, id, item);
        }
        return { ...publicMessage(item), resourceId: id, kind: item.kind, name: item.name, size: item.size };
      });
      return { items, status: result.status, nextPageToken: result.nextPageToken };
    },
  });
  ctx.tools.register({
    name: 'open_im_attachment',
    description: 'Explicitly fetch one saved attachment or thumbnail into the configured cache. Returns a local path and download status. Larger known files may require the user to approve that individual attachment in settings.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ...address, resourceId: string, attachmentId: string },
      required: ['botId', 'conversationId', 'attachmentId'],
    },
    output,
    async execute(args, options) {
      if (!args.messageId && (!args.resourceId || !await canRead(args))) return { items: [], status: 'unavailable' };
      const message = args.messageId ? await get(args) : null;
      const asset = () => (args.resourceId ? lookupResource(args, message) : message)
        ?.attachments?.find(({ id }) => id === args.attachmentId);
      const attachment = asset();
      const provider = runtime.provider(args.botId);
      if (!attachment?.source) return { items: [], status: 'unavailable' };
      const authorize = async () => {
        if (!await canRead(args) || runtime.provider(args.botId) !== provider) return false;
        if (!message) return Boolean(lookupResource(args, null));
        const current = store.message(args.botId, args.conversationId, args.messageId);
        return current?.cursor === message.cursor && !current.details.deleted
          && current.details.updatedAt === message.details.updatedAt
          && (!args.resourceId || Boolean(store.resource(current, args.resourceId)));
      };
      try {
        const result = await storage.download([args.botId, args.conversationId, args.messageId, args.resourceId],
          attachment, (limits) => {
            if (!provider?.open) throw Object.assign(new Error('Messaging connection is unavailable.'), { code: 'provider-unavailable' });
            return provider.open(attachment.source, limits);
          }, { signal: options?.signal, authorize });
        return { items: [{ ...attachmentMetadata(attachment), ...result }] };
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        const httpStatus = error.status ?? error.response?.status;
        const status = httpStatus === 401 || httpStatus === 403 ? 'permission-denied'
          : httpStatus === 404 || httpStatus === 410 ? 'expired-or-unavailable'
            : error.code ?? 'download-failed';
        return { items: [{ ...attachmentMetadata(attachment), status }] };
      }
    },
  });
}
import { createHash } from 'node:crypto';
import { attachmentMetadata, inboxReply } from '../../src/channels/shared/multiple-connect.mjs';
