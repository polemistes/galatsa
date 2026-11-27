// SPDX-License-Identifier: GPL-3.0-or-later

// Framed records: every journal entry and checkpoint the layer stores carries
// its length and a checksum, so that a record cut short or damaged on disk is
// recognised and never applied. Section 4.1 of docs/adr/0006-storage.md.
//
//   offset  size  field
//   0       4     magic "GLST"
//   4       1     version (1)
//   5       1     kind (1 = journal entry, 2 = checkpoint)
//   6       2     reserved, 0
//   8       4     header length H (little endian)
//   12      4     payload length P
//   16      4     CRC-32 of the H + P bytes that follow
//   20      H     header: UTF-8 JSON object
//   20 + H  P     payload

import { crc32 } from "@galatsa/format";

export const FRAME_KIND = { journal: 1, checkpoint: 2 } as const;
export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];

const MAGIC = [0x47, 0x4c, 0x53, 0x54];
const PREFIX = 20;

export interface Frame {
  kind: FrameKind;
  header: Record<string, unknown>;
  payload: Uint8Array;
}

export function encodeFrame(
  kind: FrameKind,
  header: Record<string, unknown>,
  payload: Uint8Array,
): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(PREFIX + head.length + payload.length);
  out.set(MAGIC, 0);
  out[4] = 1;
  out[5] = kind;
  const view = new DataView(out.buffer);
  view.setUint32(8, head.length, true);
  view.setUint32(12, payload.length, true);
  out.set(head, PREFIX);
  out.set(payload, PREFIX + head.length);
  view.setUint32(16, crc32(out.subarray(PREFIX)), true);
  return out;
}

/** The record, or null if the bytes are not a complete, intact frame. */
export function decodeFrame(bytes: Uint8Array, kind: FrameKind): Frame | null {
  if (bytes.length < PREFIX) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
  if (bytes[4] !== 1 || bytes[5] !== kind || bytes[6] !== 0 || bytes[7] !== 0)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLength = view.getUint32(8, true);
  const payloadLength = view.getUint32(12, true);
  if (PREFIX + headLength + payloadLength !== bytes.length) return null;
  if (crc32(bytes.subarray(PREFIX)) !== view.getUint32(16, true)) return null;
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(PREFIX, PREFIX + headLength),
      ),
    );
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
  return {
    kind,
    header: header as Record<string, unknown>,
    payload: bytes.subarray(PREFIX + headLength),
  };
}
