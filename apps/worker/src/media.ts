import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { MediaKind } from '@wa/provider';

export class MediaError extends Error {
  override name = 'MediaError';
}

// Separate lists: Node matches IPv4 addresses against IPv4-mapped IPv6 rules, so a shared list
// containing ::ffff:0:0/96 would block every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked4.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return mapped ? blocked4.check(mapped[1]!, 'ipv4') : blocked6.check(ip, 'ipv6');
  }
  return true;
}

/**
 * DNS lookup that refuses private addresses. Checked at connect time, so a hostname that
 * re-resolves to an internal IP between validation and fetch (DNS rebinding) is still refused.
 */
function safeLookup(hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) {
  dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(new MediaError(`Media host ${hostname} resolves to a private address`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

export type FetchMediaOptions = {
  maxBytes: number;
  /** What the download must be; a web page (or, for images, a non-image) is refused with a clear message. */
  kind?: MediaKind;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: skip the private-address checks. */
  allowPrivate?: boolean;
};

const NOUN: Record<MediaKind, string> = { image: 'an image', video: 'a video', audio: 'an audio', document: 'a document', sticker: 'a sticker' };
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/unknown']);
const isImageKind = (kind?: MediaKind) => kind === 'image' || kind === 'sticker';

/** Image formats WhatsApp can show, by their magic bytes — servers often send a wrong or generic content type. */
export function sniffImage(data: Buffer): string | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const isHtml = (contentType: string | null, data?: Buffer) =>
  contentType === 'text/html' || contentType === 'application/xhtml+xml' || /^\s*<(!doctype html|html)/i.test(data?.subarray(0, 256).toString('latin1') ?? '');

/** The usual mistake: a link to a page that shows the file (Behance, Pinterest, Drive…) instead of the file. */
function pageError(kind: MediaKind) {
  const hint = isImageKind(kind) ? ' (open the image, right-click it and choose "Copy image address")' : '';
  return new MediaError(`The ${kind} link opens a web page, not ${NOUN[kind]} file. Use a direct link to the file itself${hint}.`);
}

const unsupportedImage = (contentType: string | null) =>
  new MediaError(`The image link returned ${contentType ?? 'an unknown file type'}, which WhatsApp can't show as an image. Use a JPG, PNG or WebP image.`);

function statusError(status: number, url: URL) {
  if (status === 401 || status === 403) return new MediaError(`${url.hostname} refused the download (HTTP ${status}). Use a public, direct link to the file.`);
  if (status === 404 || status === 410) return new MediaError(`The media link was not found (HTTP ${status}).`);
  return new MediaError(`Media URL returned HTTP ${status}`);
}

/** Accept header per kind; images avoid AVIF/HEIC, which WhatsApp doesn't show. */
const accept = (kind?: MediaKind) => (isImageKind(kind) ? 'image/jpeg,image/png;q=0.9,image/webp;q=0.8,image/gif;q=0.7,*/*;q=0.1' : '*/*');

/** Downloads outbound media for sending, with SSRF protection, a size cap and a total timeout. */
export async function fetchMedia(url: string, options: FetchMediaOptions): Promise<{ data: Buffer; mimetype: string | null }> {
  const { maxBytes, kind, timeoutMs = 30_000, maxRedirects = 3, allowPrivate = false } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new MediaError('Only http(s) media URLs are allowed');
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && isBlockedAddress(host)) throw new MediaError('Media URL points to a private address');

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const client = current.protocol === 'https:' ? https : http;
      client
        // A crawler-style user agent: some hosts refuse requests that don't look like one.
        .get(
          current,
          {
            signal,
            lookup: allowPrivate ? undefined : (safeLookup as never),
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; wa-platform/0.1)', accept: accept(kind) },
          },
          resolve,
        )
        .on('error', reject);
    }).catch((err: Error) => {
      if (err instanceof MediaError) throw err;
      throw new MediaError(signal.aborted ? 'Media download timed out' : `Media download failed: ${err.message}`);
    });

    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw statusError(status, current);
    }
    // Refuse what the headers already give away, before downloading it. An .html document is allowed.
    const contentType = res.headers['content-type']?.split(';')[0]?.trim().toLowerCase() || null;
    const htmlAllowed = kind === 'document' && /\.html?$/i.test(current.pathname);
    const early =
      kind && !htmlAllowed && isHtml(contentType)
        ? pageError(kind)
        : isImageKind(kind) && contentType && !contentType.startsWith('image/') && !GENERIC_TYPES.has(contentType)
          ? unsupportedImage(contentType)
          : null;
    if (early) {
      res.destroy();
      throw early;
    }
    if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
      res.destroy();
      throw new MediaError(`Media exceeds ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.destroy();
          throw new MediaError(`Media exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk as Buffer);
      }
    } catch (err) {
      if (err instanceof MediaError) throw err;
      throw new MediaError(signal.aborted ? 'Media download timed out' : 'Media download interrupted');
    }
    const data = Buffer.concat(chunks);
    // The bytes decide: the content type may be generic or wrong.
    if (isImageKind(kind)) {
      const sniffed = sniffImage(data);
      if (sniffed) return { data, mimetype: sniffed };
      throw isHtml(null, data) ? pageError(kind!) : unsupportedImage(contentType);
    }
    if (kind && !htmlAllowed && isHtml(null, data)) throw pageError(kind);
    return { data, mimetype: res.headers['content-type']?.trim() || null };
  }
  throw new MediaError('Too many redirects');
}
