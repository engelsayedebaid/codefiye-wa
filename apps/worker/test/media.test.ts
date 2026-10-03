import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchMedia, isBlockedAddress, MediaError, sniffImage } from '../src/media';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(92, 1)]);

describe('isBlockedAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip'])(
    'blocks %s',
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('fetchMedia', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/img') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.alloc(100, 1));
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/img' });
        res.end();
      } else if (req.url === '/png-generic') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(PNG);
      } else if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>cr7 wallpaper</title>');
      } else if (req.url === '/page-generic') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('  <!DOCTYPE html><html></html>');
      } else if (req.url === '/svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/forbidden') {
        res.writeHead(403);
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(5_000));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses loopback by IP and by hostname', async () => {
    await expect(fetchMedia(`${base}/img`, { maxBytes: 1_000 })).rejects.toThrow(MediaError);
    const port = new URL(base).port;
    await expect(fetchMedia(`http://localhost:${port}/img`, { maxBytes: 1_000 })).rejects.toThrow(/private address/);
  });

  it('refuses cloud metadata endpoints', async () => {
    await expect(fetchMedia('http://169.254.169.254/latest/meta-data', { maxBytes: 1_000 })).rejects.toThrow(/private address/);
  });

  it('refuses non-http schemes', async () => {
    await expect(fetchMedia('file:///etc/passwd', { maxBytes: 1_000 })).rejects.toThrow(/http/);
  });

  it('downloads and follows redirects', async () => {
    const media = await fetchMedia(`${base}/redirect`, { maxBytes: 1_000, allowPrivate: true });
    expect(media.data.length).toBe(100);
    expect(media.mimetype).toBe('image/png');
  });

  it('enforces the size cap', async () => {
    await expect(fetchMedia(`${base}/big`, { maxBytes: 1_000, allowPrivate: true })).rejects.toThrow(/exceeds/);
  });

  it('reports HTTP errors', async () => {
    await expect(fetchMedia(`${base}/missing`, { maxBytes: 1_000, allowPrivate: true })).rejects.toThrow(/HTTP 404/);
    await expect(fetchMedia(`${base}/forbidden`, { maxBytes: 1_000, allowPrivate: true })).rejects.toThrow(/refused the download \(HTTP 403\)/);
  });

  it('refuses a web page where a file is expected', async () => {
    const opts = { maxBytes: 1_000, allowPrivate: true } as const;
    await expect(fetchMedia(`${base}/page`, { ...opts, kind: 'image' })).rejects.toThrow(/opens a web page, not an image file/);
    await expect(fetchMedia(`${base}/page-generic`, { ...opts, kind: 'image' })).rejects.toThrow(/web page/);
    await expect(fetchMedia(`${base}/page`, { ...opts, kind: 'video' })).rejects.toThrow(/not a video file/);
    await expect(fetchMedia(`${base}/page`, { ...opts, kind: 'document' })).rejects.toThrow(/not a document file/);
  });

  it('refuses images WhatsApp cannot show', async () => {
    const opts = { maxBytes: 1_000, allowPrivate: true, kind: 'image' } as const;
    await expect(fetchMedia(`${base}/svg`, opts)).rejects.toThrow(/image\/svg\+xml.*JPG, PNG or WebP/);
    await expect(fetchMedia(`${base}/json`, opts)).rejects.toThrow(/application\/json/);
  });

  it('trusts the bytes over a generic content type', async () => {
    const media = await fetchMedia(`${base}/png-generic`, { maxBytes: 1_000, allowPrivate: true, kind: 'image' });
    expect(media.mimetype).toBe('image/png');
  });
});

describe('sniffImage', () => {
  it('recognises the formats WhatsApp shows', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();
  });
});
