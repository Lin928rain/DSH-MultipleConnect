export function attachmentMetadata(item, index) {
  return {
    id: String(item?.id ?? index + 1),
    type: item?.type ?? item?.kind ?? 'file',
    ...(item?.name || item?.filename ? { name: item.name ?? item.filename } : {}),
    ...(typeof item?.mediaType === 'string' ? { mediaType: item.mediaType } : {}),
    ...(Number.isSafeInteger(item?.size) && item.size >= 0 ? { size: item.size } : {}),
    ...(item?.preview === true ? { preview: true } : {}),
    ...(typeof item?.unavailableReason === 'string' ? { unavailableReason: item.unavailableReason } : {}),
    ...(item?.source ? { downloadAvailable: true } : {}),
  };
}

export function inboxAttachments(items) {
  return (items ?? []).map((item, index) => ({
    ...attachmentMetadata(item, index),
    ...(item?.source ? { source: item.source } : {}),
  }));
}

export function inboxReply(reply) {
  if (!reply) return undefined;
  const { messageId, content, authorId, authorName, unavailableReason, attachments } = reply;
  return { messageId, content, authorId, authorName, unavailableReason,
    ...(attachments?.length ? { attachments: inboxAttachments(attachments) } : {}) };
}

// Only this delivery decision depends on connection mode.
export function captureExternal(harness, envelope) {
  const connection = harness?.multipleConnect;
  if (!connection) return false;
  const message = typeof envelope === 'function' ? envelope() : envelope;
  return connection.receive(message) !== 'internal';
}

// The model sees the same identifiers and attachment inventory as the inbox tool.
// Native loaders stay behind the explicitly requested attachment operation.
export function inboxPrompt(message, botId) {
  const { messageId, conversationId, attachments, forwards, replyTo, threadId, albumId, parts, forwardOrigin } = message;
  const visible = (attachments ?? []).slice(0, 12).map(attachmentMetadata);
  const info = { botId, conversationId, messageId,
    ...(visible.length ? { attachments: visible, attachmentCount: attachments.length } : {}),
    ...(forwards?.length ? { forwardCount: forwards.length } : {}),
    ...(replyTo?.messageId ? { replyTo: replyTo.messageId } : {}),
    ...(threadId ? { threadId } : {}), ...(albumId ? { albumId } : {}),
    ...(parts?.length ? { parts: parts.slice(0, 8) } : {}), ...(forwardOrigin ? { forwardOrigin } : {}),
  };
  return '[IM message] ' + JSON.stringify(info);
}

export function managedInboxInput(harness, original, record) {
  if (!harness?.multipleConnect || !record) return original;
  const note = inboxPrompt(record, harness.multipleConnect.botId);
  const reply = inboxReply(record.replyTo ?? original.replyTo);
  return {
    ...original, content: [original.content || record.text, note].filter(Boolean).join('\n'),
    images: [], files: [],
    ...(reply ? { replyTo: { ...reply, attachments: reply.attachments?.map((item, index) => ({
      ...attachmentMetadata(item, index), kind: item.type,
    })) } } : {}),
  };
}

// Those commands used to assign an independent workspace or Session to each
// chat. Shared-main connections leave ownership to the Host.
export function isMultipleConnectSessionCommand(harness, text) {
  return Boolean(harness?.multipleConnect)
    && /^\/(?:new|session|sessionlist|conv|workspace|clear|compact|permission|perm|history|model|preset)(?:@[^\s]+)?(?:\s|$)/iu.test(text);
}
