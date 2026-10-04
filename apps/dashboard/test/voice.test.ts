import { describe, expect, it } from 'vitest';
import { oggCrc, opusSamples, readWebmOpus, webmToOgg } from '../src/app/chats/voice';

const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const OPUS_HEAD = bytes([...new TextEncoder().encode('OpusHead')], [1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
/** 20 ms CELT frames (TOC 0xF8 = config 31, one frame). */
const packet = (fill: number, length = 40) => bytes([0xf8], Array.from({ length: length - 1 }, () => fill));
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
/** EBML element size (1 or 2 bytes). */
const size = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);

/** A WebM shaped like Chrome's MediaRecorder output: unknown-size Segment and Cluster. */
function webm(packets: Uint8Array[]) {
  const codecId = bytes([0x86, ...size(6)], new TextEncoder().encode('A_OPUS'));
  const codecPrivate = bytes([0x63, 0xa2, ...size(OPUS_HEAD.length)], OPUS_HEAD);
  const entry = bytes([0xae, ...size(codecId.length + codecPrivate.length)], codecId, codecPrivate);
  const tracks = bytes([0x16, 0x54, 0xae, 0x6b, ...size(entry.length)], entry);
  const blocks = packets.map((p, i) => bytes([0xa3, ...size(p.length + 4), 0x81, (i >> 8) & 0xff, i & 0xff, 0x80], p));
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80], [0x18, 0x53, 0x80, 0x67], UNKNOWN, tracks, [0x1f, 0x43, 0xb6, 0x75], UNKNOWN, [0xe7, 0x81, 0x00], ...blocks);
}

describe('voice notes', () => {
  it('uses the Ogg CRC (polynomial 0x04C11DB7, no reflection)', () => {
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
  });

  it('counts Opus samples from the TOC byte', () => {
    expect(opusSamples(Uint8Array.of(0xf8))).toBe(960); // CELT 20 ms
    expect(opusSamples(Uint8Array.of(0x08))).toBe(960); // SILK 20 ms
    expect(opusSamples(Uint8Array.of(0xfb, 0x03))).toBe(2880); // three 20 ms frames
  });

  it('reads the Opus header and packets of a recording', () => {
    const { head, packets } = readWebmOpus(webm([packet(1), packet(2)]));
    expect(head).toEqual(OPUS_HEAD);
    expect(packets).toEqual([packet(1), packet(2)]);
  });

  it('writes valid Ogg pages with the right granule positions', () => {
    const packets = Array.from({ length: 300 }, (_, i) => packet(i % 256, 300)); // 2 lacing values each → several pages
    const ogg = webmToOgg(webm(packets));
    const pages: { flags: number; granule: number; sequence: number }[] = [];
    let at = 0;
    while (at < ogg.length) {
      expect(new TextDecoder().decode(ogg.subarray(at, at + 4))).toBe('OggS');
      const view = new DataView(ogg.buffer, ogg.byteOffset + at);
      const segments = ogg[at + 26]!;
      const size = 27 + segments + ogg.subarray(at + 27, at + 27 + segments).reduce((n, s) => n + s, 0);
      const copy = ogg.slice(at, at + size);
      copy.fill(0, 22, 26);
      expect(oggCrc(copy)).toBe(view.getUint32(22, true));
      pages.push({ flags: ogg[at + 5]!, granule: view.getUint32(6, true), sequence: view.getUint32(18, true) });
      at += size;
    }
    expect(pages[0]).toMatchObject({ flags: 0x02, granule: 0, sequence: 0 });
    expect(new TextDecoder().decode(ogg.subarray(28, 36))).toBe('OpusHead');
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));
    expect(pages.at(-1)).toMatchObject({ flags: 0x04, granule: 300 * 960 });
  });

  it('refuses audio that is not Opus', () => {
    const vorbis = webm([packet(1)]);
    vorbis.set(new TextEncoder().encode('A_VORB'), vorbis.indexOf(0x86) + 2);
    expect(() => readWebmOpus(vorbis)).toThrow(/not Opus/);
  });
});
