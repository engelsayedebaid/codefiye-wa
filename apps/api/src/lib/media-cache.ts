import type { FastifyReply, FastifyRequest } from 'fastify';

export type CachedMedia = { data: Buffer; mimetype: string; fileName: string | null };

/**
 * Decrypted chat media, least recently used first out, bounded by total bytes. Downloading from
 * WhatsApp means fetching and decrypting the whole file, and players ask for it in ranges (seeking a
 * video), so one download serves them all. Loads of the same message share one download.
 */
export class MediaCache {
  private readonly entries = new Map<string, CachedMedia>();
  private readonly loading = new Map<string, Promise<CachedMedia>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 200 * 1024 * 1024,
    private readonly maxEntryBytes = 64 * 1024 * 1024,
  ) {}

  async get(key: string, load: () => Promise<CachedMedia>): Promise<CachedMedia> {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert: Map order is the recency order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const promise = load()
      .then((media) => {
        this.put(key, media);
        return media;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }

  private put(key: string, media: CachedMedia) {
    if (media.data.length > this.maxEntryBytes) return;
    this.entries.set(key, media);
    this.bytes += media.data.length;
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entry.data.length;
    }
  }
}

/** RFC 7233 single range (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`); null = whole file, false = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (!from && !to) return null;
  let start: number;
  let end: number;
  if (!from) {
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to ? Math.min(Number(to), size - 1) : size - 1;
  }
  return start > end || start >= size ? false : { start, end };
}

/** Sends media with Range support; the content never changes for a message, so browsers may keep it. */
export function sendMedia(req: FastifyRequest, reply: FastifyReply, media: CachedMedia, download: boolean) {
  const size = media.data.length;
  reply.header('content-type', media.mimetype);
  reply.header('accept-ranges', 'bytes');
  reply.header('cache-control', 'private, max-age=86400, immutable');
  if (download) {
    const name = (media.fileName ?? 'file').replace(/["\\\r\n]/g, '_');
    reply.header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  const range = parseRange(req.headers.range, size);
  if (range === false) {
    reply.header('content-range', `bytes */${size}`);
    return reply.code(416).send();
  }
  if (!range) {
    reply.header('content-length', size);
    return reply.send(media.data);
  }
  reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
  reply.header('content-length', range.end - range.start + 1);
  return reply.code(206).send(media.data.subarray(range.start, range.end + 1));
}
