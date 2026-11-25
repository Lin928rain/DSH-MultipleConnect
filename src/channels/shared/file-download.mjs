async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Preserve the original download failure.
  }
}

function hostedByMessagingPlatform(target, allowedHosts) {
  return !Array.isArray(allowedHosts) || allowedHosts.some((rule) => (
    typeof rule === 'string'
    && (target.hostname === rule
      || (rule.startsWith('.')
        && (target.hostname === rule.slice(1) || target.hostname.endsWith(rule))))
  ));
}

/**
 * Open a channel-hosted ordinary file as a stream.
 *
 * This deliberately has no plugin-defined size, type, count, or download-time
 * limit. The caller owns cancellation through its AbortSignal and the channel
 * remains the authority for its own file limits.
 */
export async function fetchFileStream(url, {
  fetchImpl = fetch,
  headers,
  signal,
  allowedHosts,
  maxBytes,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('File download URL must use HTTPS');
  if (maxBytes !== undefined && (target.username || target.password || target.port && target.port !== '443')) {
    throw new Error('Invalid file download URL');
  }
  if (!hostedByMessagingPlatform(target, allowedHosts)) {
    throw new Error('File download URL is not hosted by the messaging platform');
  }

  const response = await fetchImpl(target, {
    method: 'GET',
    headers,
    signal,
    redirect: 'manual',
  });
  if (Number.isInteger(response?.status) && response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    const error = new Error(`File download redirect was blocked (HTTP ${response.status})`);
    error.code = 'file-redirect-blocked';
    throw error;
  }
  if (!response?.ok) {
    await cancelResponseBody(response);
    const error = new Error(`File download failed with HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'file-http-error';
    error.status = response?.status;
    throw error;
  }
  const declared = response.headers?.get?.('content-length');
  const size = declared && /^\d+$/.test(declared) ? Number(declared) : undefined;
  if (maxBytes !== undefined && size > maxBytes) {
    await cancelResponseBody(response);
    throw Object.assign(new Error('Attachment exceeds the download budget.'), { code: 'attachment-limit' });
  }
  if (response.body?.[Symbol.asyncIterator]) return { stream: response.body, size };
  if (maxBytes !== undefined) {
    await cancelResponseBody(response);
    throw new Error('File download returned no readable stream');
  }
  if (typeof response.arrayBuffer === 'function') {
    const data = Buffer.from(await response.arrayBuffer());
    return {
      stream: (async function* fileBody() { yield data; }()),
    };
  }
  throw new Error('File download returned no readable body');
}
