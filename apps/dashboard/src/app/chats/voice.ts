/**
 * Voice notes. WhatsApp plays them on phones as Ogg/Opus; browsers record Opus too, but Chrome and
 * Edge wrap it in WebM. `webmToOgg` moves the same Opus packets into an Ogg file (no re-encoding,
 * no quality loss). Firefox records Ogg already; Safari records MP4/AAC, which is sent as it is.
 */

/** What MediaRecorder should produce, best first. */
export const RECORDER_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'] as const;

export function recorderType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export const canRecord = () => typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && recorderType() !== null;

/** The file to upload for a finished recording. */
export async function voiceFile(blob: Blob): Promise<File> {
  const type = blob.type.toLowerCase();
  if (type.startsWith('audio/ogg')) return new File([blob], 'voice.ogg', { type: 'audio/ogg' });
  if (type.startsWith('audio/mp4') || type.startsWith('audio/aac')) return new File([blob], 'voice.m4a', { type: 'audio/mp4' });
  try {
    const ogg = webmToOgg(new Uint8Array(await blob.arrayBuffer()));
    return new File([ogg.buffer as ArrayBuffer], 'voice.ogg', { type: 'audio/ogg' });
  } catch {
    // Not WebM/Opus after all: send it as recorded (it plays in WhatsApp Web, maybe not on every phone).
    return new File([blob], 'voice.webm', { type: 'audio/webm' });
  }
}

// --- WebM (Matroska) reading -----------------------------------------------------------------------

const ID = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  cluster: 0x1f43b675,
  blockGroup: 0xa0,
  block: 0xa1,
  simpleBlock: 0xa3,
} as const;
/** Elements whose children we read; the others are skipped by size. */
const MASTERS = new Set<number>([ID.segment, ID.tracks, ID.trackEntry, ID.cluster, ID.blockGroup]);

function vint(buf: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = buf[at];
  if (first === undefined || first === 0) throw new Error('bad vint');
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > buf.length) throw new Error('bad vint');
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[at + i]!;
    if (buf[at + i] !== 0xff) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}

/** The Opus header and audio packets of a WebM recording. */
export function readWebmOpus(buf: Uint8Array): { head: Uint8Array; packets: Uint8Array[] } {
  let head: Uint8Array | null = null;
  let codec = '';
  const packets: Uint8Array[] = [];
  let at = 0;
  while (at < buf.length) {
    let id: ReturnType<typeof vint>;
    let size: ReturnType<typeof vint>;
    try {
      id = vint(buf, at, true);
      size = vint(buf, at + id.length, false);
    } catch {
      break; // a recording cut short ends mid-element
    }
    const start = at + id.length + size.length;
    if (MASTERS.has(id.value)) {
      at = start; // read the children (sizes may be "unknown" while recording)
      continue;
    }
    if (size.unknown) throw new Error('unknown-size leaf');
    const end = Math.min(buf.length, start + size.value);
    const data = buf.subarray(start, end);
    if (id.value === ID.codecId) codec = new TextDecoder().decode(data);
    else if (id.value === ID.codecPrivate) head = data.slice();
    else if (id.value === ID.simpleBlock || id.value === ID.block) {
      const track = vint(data, 0, false);
      const flags = data[track.length + 2]!;
      if (flags & 0x06) throw new Error('laced blocks are not supported');
      packets.push(data.slice(track.length + 3));
    }
    at = end;
  }
  if (codec && codec !== 'A_OPUS') throw new Error(`not Opus: ${codec}`);
  if (!head || head.length < 19 || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') throw new Error('no Opus header');
  if (!packets.length) throw new Error('no audio');
  return { head, packets };
}

/** PCM samples (48 kHz) in an Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config % 4]! : config < 16 ? [10, 20][config % 2]! : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frames * ms * 48;
}

// --- Ogg writing -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

function page(packets: Uint8Array[], granule: number, serial: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(255, n));
      if (n < 255) break;
    }
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]); // "OggS", version 0
  view.setUint32(6, granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(granule / 2 ** 32), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  view.setUint32(22, oggCrc(out), true);
  return out;
}

/** An Ogg/Opus file from an OpusHead and the audio packets (RFC 7845). */
export function oggOpus(head: Uint8Array, packets: Uint8Array[], serial = 0x57a1c0de): Uint8Array {
  const vendor = new TextEncoder().encode('wa-platform');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [page([head], 0, serial, 0, 0x02), page([tags], 0, serial, 1, 0)];
  let granule = 0;
  let batch: Uint8Array[] = [];
  let segments = 0;
  const flush = (last: boolean) => {
    pages.push(page(batch, granule, serial, pages.length, last ? 0x04 : 0));
    batch = [];
    segments = 0;
  };
  packets.forEach((p, i) => {
    const need = Math.floor(p.length / 255) + 1;
    if (segments + need > 255) flush(false);
    batch.push(p);
    segments += need;
    granule += opusSamples(p);
    if (i === packets.length - 1) flush(true);
  });
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function webmToOgg(webm: Uint8Array): Uint8Array {
  const { head, packets } = readWebmOpus(webm);
  return oggOpus(head, packets);
}
