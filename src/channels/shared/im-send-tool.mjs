export const IM_SEND_TOOL = 'send_im';

export function createImSendToolDefinition({ send }) {
  if (typeof send !== 'function') throw new TypeError('A delivery send function is required');
  return Object.freeze({
    name: IM_SEND_TOOL,
    description: 'Send text to a saved IM target. Specify botId and targetId explicitly. The connection owner must have enabled Agent tool sending.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        botId: { type: 'string', description: 'Messaging connection ID.' },
        targetId: { type: 'string', description: 'Saved target ID on that connection.' },
        text: { type: 'string', description: 'Message text.' },
      },
      required: ['botId', 'targetId', 'text'],
    },
    output: {
      schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] },
      render: (_args, value) => [{ type: 'text', text: value.sent ? 'IM message delivered.' : 'IM message was not delivered.' }],
    },
    async execute({ botId, targetId, text }, exec) {
      if (![botId, targetId, text].every((value) => typeof value === 'string' && value.trim())) {
        throw new Error('send_im failed (bad-request): botId, targetId and text are required');
      }
      try {
        await send(botId, targetId, text, { signal: exec?.signal });
        return { sent: true };
      } catch (error) {
        throw new Error(`send_im failed (${error?.code ?? 'delivery-failed'}): ${error?.message ?? String(error)}`);
      }
    },
  });
}

export function installImSendTool(ctx, { send } = {}) {
  if (!ctx?.tools?.register || typeof send !== 'function') return false;
  ctx.tools.register(createImSendToolDefinition({ send }));
  ctx.systemPrompt?.section?.({
    name: 'dsh-multiple-connect:send-im',
    order: 117,
    text: 'Write an ordinary reply for an inbound message on an internal IM connection. Only that originating IM chat receives it automatically. For explicit IM delivery, use send_im with a specific permitted botId and targetId. External inbox notifications provide only counts. read_im_messages reads both modes, read_im_resources opens quotes and forwards, and open_im_attachment explicitly fetches one file.',
  });
  return true;
}
