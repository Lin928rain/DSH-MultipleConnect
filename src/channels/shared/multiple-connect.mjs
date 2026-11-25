// Ingress uses each channel's already validated envelope. Only JSON-safe
// attachment metadata crosses into the external inbox.
export function captureExternal(harness, envelope) {
  const connection = harness?.multipleConnect;
  if (!connection || connection.mode() !== 'external') return false;
  const { messageId, conversationId, senderId, kind, text, attachments, receivedAt } =
    typeof envelope === 'function' ? envelope() : envelope;
  return connection.receive({
    messageId, conversationId, senderId, kind, text, receivedAt,
    attachments: (Array.isArray(attachments) ? attachments : []).map((item) => ({
      type: typeof item?.type === 'string' ? item.type : item?.kind ?? 'file',
      ...(typeof item?.name === 'string' ? { name: item.name } : {}),
      ...(typeof item?.filename === 'string' ? { name: item.filename } : {}),
    })),
  }) !== 'internal';
}

// Those commands used to assign an independent workspace or Session to each
// chat. Shared-main connections leave ownership to the Host.
export function isMultipleConnectSessionCommand(harness, text) {
  return Boolean(harness?.multipleConnect)
    && /^\/(?:new|session|sessionlist|conv|workspace|clear|compact|permission|perm|history|model|preset)(?:@[^\s]+)?(?:\s|$)/iu.test(text);
}
