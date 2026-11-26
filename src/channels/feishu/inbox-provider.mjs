import { inboxAttachments, inboxReply } from '../shared/multiple-connect.mjs';
import { feishuInboxContent, feishuResourceStream } from './message-utils.mjs';

function itemRecord(item, client, ancestors) {
  const body = feishuInboxContent({
    message: { ...item, message_type: item.msg_type, content: item.body?.content,
      mentions: (item.mentions ?? []).map((mention) => ({ ...mention, id: { open_id: mention.id } })) },
  }, client, { forwarded: Boolean(item.upper_message_id) });
  const { text, attachments, replyTo, receivedAt, ...details } = body;
  return {
    messageId: item.message_id, senderId: item.sender?.id, text: item.deleted ? '' : text, receivedAt,
    attachments: item.deleted ? [] : inboxAttachments(attachments),
    details: item.deleted ? { deleted: true } : { ...details, replyTo: inboxReply(replyTo) },
    ...(ancestors && !item.deleted ? { reference: { ancestors } } : {}),
  };
}

export function createFeishuInboxProvider(client, { signal: lifetime, allowHistoryItem, allowsWakeRecipient } = {}) {
  return {
    capabilities: ['reply', 'forward', 'history'],
    allowsWakeRecipient,
    async open({ key, messageId, type }, options) {
      const signal = lifetime ? AbortSignal.any([lifetime, options.signal]) : options.signal;
      return { stream: await feishuResourceStream({ message: { message_id: messageId } }, client, key, type, { ...options, signal }) };
    },
    async query(operation, { args, message, resource, signal }) {
      const active = AbortSignal.any([lifetime, signal, AbortSignal.timeout(15_000)].filter(Boolean));
      const chatId = message.details.chatId;
      if (!chatId) return { items: [], status: 'chat-unavailable' };
      const offset = /^\d{1,6}$/.test(args.pageToken ?? '') ? Number(args.pageToken) : 0;
      const selected = resource ?? message;
      const ancestry = selected.reference?.ancestors ?? [];
      try {
        active.throwIfAborted();
        if (operation === 'history') {
          if (args.pageToken?.length > 4096) return { items: [], status: 'invalid-page' };
          const container = message.details.threadId;
          const response = await client.im.v1.message.list({ params: {
            container_id_type: container ? 'thread' : 'chat', container_id: container ?? chatId,
            sort_type: 'ByCreateTimeDesc', page_size: 20,
            ...(args.pageToken ? { page_token: args.pageToken } : {}),
          } }, { signal: active });
          active.throwIfAborted();
          if (response?.code) return { items: [], status: feishuReadStatus(response.code) };
          const items = (response?.data?.items ?? []).filter((item) => item.chat_id === chatId
            && (!container || item.thread_id === container)
            && (!allowHistoryItem || allowHistoryItem(item, message.details.chatType)));
          return { items: items.map((item) => itemRecord(item, client)),
            nextPageToken: response?.data?.has_more ? response.data.page_token : undefined };
        }
        const messageId = operation === 'reply' ? selected.details?.replyTo?.messageId
          : selected.details?.forwards?.[args.index ?? 0]?.id;
        if (!messageId) return { items: [], status: 'reference-unavailable' };
        if (ancestry.includes(messageId) || ancestry.length >= 8) return { items: [], status: 'forward-depth-limit' };
        const response = await client.im.v1.message.get({ path: { message_id: messageId } }, { signal: active });
        active.throwIfAborted();
        if (response?.code) return { items: [], status: feishuReadStatus(response.code) };
        const items = response?.data?.items ?? [];
        if (operation === 'reply') {
          const item = items.find((candidate) => candidate.message_id === messageId && candidate.chat_id === chatId);
          const snapshot = selected.details?.replyTo;
          return { items: item ? [itemRecord(item, client)] : snapshot?.content
            ? [{ text: snapshot.content, messageId, attachments: snapshot.attachments }] : [] };
        }
        const matching = items.filter((item) => item.upper_message_id === messageId && (!item.chat_id || item.chat_id === chatId));
        return { items: matching.slice(offset, offset + 20).map((item) => itemRecord(item, client, [...ancestry, messageId])),
          nextPageToken: offset + 20 < matching.length ? String(offset + 20) : undefined,
          status: matching.length ? undefined : 'reference-unavailable' };
      } catch (error) {
        signal?.throwIfAborted();
        return { items: [], status: feishuReadStatus(error?.response?.data?.code) };
      }
    },
  };
}

function feishuReadStatus(code) {
  return [230027, 99991672, 99991679].includes(code) ? 'permission-denied' : 'provider-unavailable';
}
