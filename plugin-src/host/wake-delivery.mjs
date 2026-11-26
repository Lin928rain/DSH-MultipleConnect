import { normalizeDeliveryTarget } from './delivery-adapter.mjs';
import { deliverySuggestionFromInbox } from './delivery-suggestions.mjs';

const STATE_KEY = 'wakeDelivery';
const AUTOMATIC = Object.freeze({ mode: 'automatic' });

export function createWakeDelivery({ store, main, deliveryService, providerFor, logger }) {
  const settings = () => store.getState(STATE_KEY) ?? AUTOMATIC;

  function allowed(recipient) {
    const { channel, botId, chatId, conversationId, senderId } = recipient;
    if (!store.hasChat(botId, chatId) || store.chatSettings(botId, chatId).mode !== 'internal') return false;
    const provider = providerFor(botId);
    if (channel === 'snowluma') return provider?.authorize?.(conversationId) === true;
    if (provider?.authorize && !provider.authorize(conversationId)) return false;
    if (provider?.allowsWakeRecipient) return provider.allowsWakeRecipient(senderId) === true;
    return deliveryService.allowsWakeRecipient?.(channel, botId, senderId) === true;
  }

  function* recipients(bots) {
    const seen = new Set();
    for (const { botId, channel } of bots) {
      for (const chat of store.wakeConversations(botId, channel)) {
        const suggestion = deliverySuggestionFromInbox(channel, chat);
        if (!suggestion) continue;
        let target;
        try {
          target = normalizeDeliveryTarget(channel, suggestion, { targetIdRequired: false });
        } catch (error) {
          if (error.code !== 'invalid-target') throw error;
          continue;
        }
        const id = JSON.stringify([botId, chat.chatId, target.kind, target.route]);
        const recipient = { ...chat, id, botId, channel, target };
        if (channel === 'feishu') recipient.senderId = target.route.openId;
        if (seen.has(id) || !allowed(recipient)) continue;
        seen.add(id);
        yield recipient;
      }
    }
  }

  function selectedRecipient(config, bots) {
    if (config.mode === 'pinned') {
      const { recipient } = config;
      return bots.some(({ botId, channel }) => botId === recipient.botId && channel === recipient.channel)
        && allowed(recipient) ? recipient : null;
    }
    const choices = recipients(bots);
    const first = choices.next().value;
    const ambiguous = !choices.next().done;
    choices.return();
    return ambiguous ? null : first;
  }

  const describe = ({ id, botId, channel, chatId, conversationId, name }) => ({ id, botId, channel, chatId, conversationId, name });
  return {
    async status() {
      const config = settings();
      const bots = await deliveryService.listBots();
      const choices = Array.from(recipients(bots), describe);
      const selected = config.mode === 'pinned' ? describe(config.recipient) : null;
      if (selected && !choices.some(({ id }) => id === selected.id) && selectedRecipient(config, bots)) {
        choices.push(selected);
      }
      return { mode: config.mode, selected, choices };
    },
    async configure({ mode, id }) {
      if (mode === 'automatic' || mode === 'disabled') {
        store.setState(STATE_KEY, { mode });
      } else if (mode === 'pinned' && typeof id === 'string') {
        const bots = await deliveryService.listBots();
        for (const recipient of recipients(bots)) {
          if (recipient.id !== id) continue;
          store.setState(STATE_KEY, { mode, recipient });
          return;
        }
        throw new Error('The selected private chat is no longer an eligible internal connection.');
      } else {
        throw new Error('Invalid wake delivery settings.');
      }
    },
    async send(sessionId, text) {
      if (main.current()?.sessionId !== sessionId) return undefined;
      const config = settings();
      if (config.mode === 'disabled') return 'IM delivery disabled';
      const bots = await deliveryService.listBots();
      const recipient = selectedRecipient(config, bots);
      if (!recipient) {
        if (recipient === undefined) return 'IM delivery skipped: no eligible internal private chat';
        return config.mode === 'pinned' ? 'IM delivery skipped: selected chat is unavailable'
          : 'IM delivery skipped: choose one internal private chat in DSH-MultipleConnect settings';
      }
      const authorize = () => {
        if (main.current()?.sessionId === sessionId
          && JSON.stringify(settings()) === JSON.stringify(config)
          && selectedRecipient(config, bots)?.id === recipient.id) return true;
        throw Object.assign(new Error('Wake delivery route changed before sending.'), { code: 'stale-route' });
      };
      try {
        await deliveryService.send(recipient.botId, recipient.target, text, { authorize });
        return 'IM delivered (' + recipient.channel + ')';
      } catch (error) {
        const code = error?.code ?? 'delivery-failed';
        logger.warn?.('[dsh-multiple-connect] proactive IM delivery failed:', recipient.channel, code);
        return 'IM delivery failed (' + recipient.channel + ': ' + code + ')';
      }
    },
  };
}
