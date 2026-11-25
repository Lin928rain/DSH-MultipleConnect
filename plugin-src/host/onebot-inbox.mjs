import { fetchFileStream } from '../../src/channels/shared/file-download.mjs';
import { inboxAttachments, inboxReply } from '../../src/channels/shared/multiple-connect.mjs';

const mediaHosts = ['.qq.com', '.qq.com.cn', '.qpic.cn', '.myqcloud.com', '.tencentcos.com', '.gtimg.com'];
const nativeText = (value) => typeof value === 'string' && value.length ? value : undefined;
const sizeOf = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;

export function oneBotWireId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value ?? '');
  return /^-?\d{1,16}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : '';
}

function decodeCQ(value, parameter = false) {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#44;/g, parameter ? ',' : '&#44;').replace(/&amp;/g, '&');
}

export function oneBotSegments(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item?.type === 'string');
  if (typeof value !== 'string') return [];
  const segments = [];
  let offset = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z0-9_-]+)((?:,[^\[\]]*)?)\]/gu)) {
    if (match.index > offset) segments.push({ type: 'text', data: { text: decodeCQ(value.slice(offset, match.index)) } });
    const data = Object.create(null);
    for (const parameter of match[2].slice(1).split(',')) {
      const equals = parameter.indexOf('=');
      if (equals > 0) data[parameter.slice(0, equals)] = decodeCQ(parameter.slice(equals + 1), true);
    }
    segments.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  if (offset < value.length) segments.push({ type: 'text', data: { text: decodeCQ(value.slice(offset)) } });
  return segments;
}

function mediaURL(value) {
  if (!/^(?:https?:)?\/\//i.test(value ?? '')) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!mediaHosts.some((host) => url.hostname.endsWith(host))) return undefined;
    if (url.protocol === 'http:' && (!url.port || url.port === '80')) url.protocol = 'https:';
    return url.href;
  } catch { return undefined; }
}

function segmentAsset(type, data, route, messageId, index) {
  const name = nativeText(data.name ?? data.file_name ?? data.file);
  const url = mediaURL(data.url) ?? mediaURL(data.file);
  const fileId = nativeText(data.file_id ?? data.id);
  const source = type === 'file' && route?.kind === 'group' && fileId
    ? { groupId: route.chatId, fileId, busid: data.busid, url }
    : url || messageId ? { url, messageId, index, route } : undefined;
  return { type, name: mediaURL(name) ? undefined : name, size: sizeOf(data.file_size ?? data.size), source };
}

export function oneBotContent(segments, { route, messageId, selfId, inlineReply = true } = {}) {
  const attachments = [];
  const forwards = [];
  const parts = [];
  const body = [];
  let replyTo;
  for (const [index, item] of segments.entries()) {
    const { type } = item;
    const data = item.data ?? {};
    if (type === 'text' || type === 'markdown') {
      body.push(nativeText(data.text ?? data.content) ?? '');
    } else if (type === 'at') {
      if (String(data.qq) !== selfId) body.push('@' + (oneBotWireId(data.qq) || 'all'));
    } else if (type === 'reply') {
      const id = oneBotWireId(data.id);
      const quoted = inlineReply ? oneBotContent(oneBotSegments(data.message ?? data.content), { route, inlineReply: false }) : null;
      if (id || quoted?.text || quoted?.attachments.length) {
        replyTo ??= { messageId: id || undefined, content: quoted?.text, attachments: quoted?.attachments };
        if (id) body.push('[Reply to QQ message ' + id + ']');
      }
    } else if (type === 'forward') {
      const id = nativeText(data.id ?? data.res_id ?? data.forward_id);
      if (id) forwards.push({ id });
      else if (messageId) forwards.push({ messageId });
      body.push('[forward]');
    } else if (['image', 'record', 'video', 'file'].includes(type)) {
      attachments.push(segmentAsset(type === 'record' ? 'audio' : type, data, route, messageId, index));
      const thumbnail = mediaURL(data.thumb);
      if (thumbnail) attachments.push({ type: 'image', preview: true, source: { url: thumbnail } });
      body.push('[' + type + ']');
    } else {
      parts.push({ type, ...(type === 'face' ? { id: String(data.id ?? '') } : {}),
        ...(type === 'location' ? { latitude: data.lat, longitude: data.lon, title: data.title, address: data.content } : {}) });
      body.push('[' + type + ']');
    }
  }
  return { text: body.join('').trim(), attachments, replyTo, forwards, parts };
}

function scopedMessage(item, route, selfId) {
  if (route.kind === 'group') return oneBotWireId(item?.group_id) === route.chatId;
  if (item?.group_id || item?.message_type === 'group') return false;
  const author = oneBotWireId(item?.user_id ?? item?.sender?.user_id);
  return author === route.chatId || author === selfId && oneBotWireId(item?.target_id ?? item?.peer_id) === route.chatId;
}

function nativeMessage(item, route, ancestors = []) {
  if (item?.type === 'node' && item.data) item = item.data;
  const messageId = oneBotWireId(item?.message_id);
  const { text, attachments, replyTo, ...details } = oneBotContent(oneBotSegments(item?.message ?? item?.content ?? item?.raw_message), {
    route, messageId: ancestors.length ? undefined : messageId, selfId: route.selfId,
  });
  return { messageId: messageId || undefined, senderId: oneBotWireId(item?.sender?.user_id ?? item?.user_id ?? item?.uin),
    senderName: nativeText(item?.sender?.nickname ?? item?.nickname ?? item?.name), text,
    receivedAt: sizeOf(item?.time) ? Number(item.time) * 1000 : undefined,
    attachments: inboxAttachments(attachments), details: { ...details, replyTo: inboxReply(replyTo) },
    ...(ancestors.length ? { reference: { ancestors } } : {}),
  };
}

function pageSlice(items, token) {
  const offset = /^\d{1,6}$/.test(token ?? '') ? Number(token) : 0;
  return { items: items.slice(offset, offset + 20), nextPageToken: offset + 20 < items.length ? String(offset + 20) : undefined };
}

function albumAsset(image, preview = false) {
  const url = mediaURL(image?.defaultUrl?.url ?? image?.photoUrls?.[0]?.url?.url);
  return url ? [{ type: 'image', name: nativeText(image.name) ?? 'photo.jpg', preview, source: { url } }] : [];
}

function currentRoute(account, conversationId) {
  const [self, kind, chatId, extra] = String(conversationId).split(':');
  if (extra !== undefined || !account.accountId || self !== account.accountId) return undefined;
  if (kind === 'private' && account.users.includes(chatId) || kind === 'group' && account.groups.includes(chatId)) {
    return { kind, chatId, selfId: self };
  }
}

export function createOneBotInboxProvider(account, socket, lifetime) {
  return {
    capabilities: ['reply', 'forward', 'history', 'group-files', 'group-albums', 'album-media'],
    conversationCapabilities: ['history', 'group-files', 'group-albums', 'album-media'],
    conversations() {
      if (!account.accountId) return [];
      return [
        ...account.groups.map((id) => ({ kind: 'group', conversationId: `${account.accountId}:group:${id}` })),
        ...account.users.map((id) => ({ kind: 'direct', conversationId: `${account.accountId}:private:${id}` })),
      ];
    },
    authorize: (conversationId) => Boolean(currentRoute(account, conversationId)),
    async open(source, limits) {
      const signal = AbortSignal.any([lifetime, limits.signal]);
      let url = mediaURL(source.url);
      if (source.groupId && source.fileId && account.groups.includes(source.groupId)) {
        url = await socket.request('get_group_file_url', {
          group_id: Number(source.groupId), file_id: source.fileId, busid: source.busid,
        }, signal).then((item) => mediaURL(item?.url), () => url);
      } else if (!url && source.messageId && source.route) {
        const item = await socket.request('get_msg', { message_id: Number(source.messageId) }, signal);
        if (scopedMessage(item, source.route, account.accountId)) {
          const data = oneBotSegments(item.message ?? item.raw_message)[source.index]?.data;
          url = mediaURL(data?.url) ?? mediaURL(data?.file);
        }
      }
      if (!url) throw Object.assign(new Error('No downloadable OneBot media URL.'), { code: 'attachment-unavailable' });
      return fetchFileStream(url, { ...limits, signal, allowedHosts: mediaHosts });
    },
    async query(operation, { args, message, resource, signal }) {
      const route = currentRoute(account, args.conversationId);
      if (!route) return { items: [], status: 'permission-denied' };
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      const selected = resource ?? message;
      const groupId = Number(route.chatId);
      const request = (action, params) => socket.request(action, params, active);
      try {
        if (operation === 'reply') {
          const reply = selected.details?.replyTo;
          if (reply?.content || reply?.attachments?.length) {
            return { items: [{ text: reply.content, messageId: reply.messageId, attachments: reply.attachments }] };
          }
          if (!oneBotWireId(reply?.messageId) || resource?.reference?.ancestors?.length) return { items: [], status: 'reference-unavailable' };
          const item = await request('get_msg', { message_id: Number(reply.messageId) });
          return { items: scopedMessage(item, route, account.accountId) ? [nativeMessage(item, route)] : [] };
        }
        if (operation === 'forward') {
          const reference = selected.details?.forwards?.[args.index ?? 0];
          if (!reference) return { items: [], status: 'reference-unavailable' };
          const ancestry = selected.reference?.ancestors ?? [];
          const id = reference.id ?? 'msg:' + reference.messageId;
          if (ancestry.includes(id) || ancestry.length >= 8) return { items: [], status: 'forward-depth-limit' };
          const data = await request('get_forward_msg', reference.id ? { id: reference.id } : { message_id: reference.messageId });
          const nodes = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
          const page = pageSlice(nodes, args.pageToken);
          return { ...page, items: page.items.map((item) => nativeMessage(item, route, [...ancestry, id])) };
        }
        if (operation === 'history') {
          const group = route.kind === 'group';
          const anchor = oneBotWireId(args.pageToken);
          const result = await request(group ? 'get_group_msg_history' : 'get_friend_msg_history', {
            [group ? 'group_id' : 'user_id']: groupId, count: 20, ...(anchor ? { message_id: Number(anchor) } : {}),
          });
          const items = (result?.messages ?? []).filter((item) => scopedMessage(item, route, account.accountId)
            && oneBotWireId(item.message_id) !== anchor).map((item) => nativeMessage(item, route));
          return { items, nextPageToken: result?.messages?.length >= 20 ? items[0]?.messageId : undefined };
        }
        if (route.kind !== 'group') return { items: [], status: 'group-required' };
        if (operation === 'group-files') {
          const folder = resource?.reference?.folderId;
          if (resource && !folder) return { items: [], status: 'folder-required' };
          const result = await request(folder ? 'get_group_files_by_folder' : 'get_group_root_files', {
            group_id: groupId, ...(folder ? { folder_id: folder } : {}),
          });
          const folders = (result?.folders ?? []).filter((item) => item?.folder_id).map((item) => ({
            kind: 'folder', name: item.folder_name, reference: { folderId: item.folder_id },
          }));
          const files = (result?.files ?? []).filter((item) => item?.file_id).map((item) => ({
            kind: 'file', name: item.file_name, size: sizeOf(item.file_size),
            attachments: inboxAttachments([{ type: 'file', name: item.file_name, size: sizeOf(item.file_size),
              source: { groupId: route.chatId, fileId: item.file_id, busid: item.busid } }]),
          }));
          return pageSlice([...folders, ...files], args.pageToken);
        }
        if (operation === 'group-albums') {
          const albums = await request('get_group_album_list', { group_id: groupId });
          return pageSlice((Array.isArray(albums) ? albums : []).filter((item) => item?.id).map((item) => ({
            kind: 'album', name: item.name, reference: { albumId: item.id },
            attachments: inboxAttachments(albumAsset(item.cover?.image, true)),
          })), args.pageToken);
        }
        if (operation === 'album-media') {
          const album = resource?.reference?.albumId;
          if (!album || args.pageToken?.length > 8192) return { items: [], status: 'album-required' };
          const result = await request('get_group_album_media_list', {
            group_id: groupId, album_id: album, attach_info: args.pageToken ?? '',
          });
          return { items: (result?.mediaList ?? []).map((item) => {
            const video = mediaURL(item.video?.url ?? item.video?.videoUrl?.[0]?.url?.url);
            return { kind: item.video ? 'video' : 'image', name: item.image?.name, attachments: inboxAttachments([
              ...albumAsset(item.image), ...albumAsset(item.video?.cover, true),
              ...(video ? [{ type: 'video', name: 'video.mp4', source: { url: video } }] : []),
            ]) };
          }), nextPageToken: result?.nextAttachInfo || undefined };
        }
        return { items: [], status: 'unsupported' };
      } catch (error) {
        signal?.throwIfAborted();
        return { items: [], status: error?.code === 'target-rejected' ? 'provider-rejected-or-unsupported' : 'provider-unavailable' };
      }
    },
  };
}
