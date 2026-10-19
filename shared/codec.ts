// reface DX SysEx codec (docs/sysex-spec.md §1). Pure functions, no IO.
import { COMMON_SIZE, OP_SIZE, type ParamDef, type VoiceData, encodeValue, type ParamValue } from './params.ts';

export type Bytes = number[];
export type Address = readonly [number, number, number];

const MODEL = 0x05;
const PREFIX = [0xf0, 0x43] as const;
const GROUP = [0x7f, 0x1c] as const;

export const ADDR_HEADER: Address = [0x0e, 0x0f, 0x00];
export const ADDR_FOOTER: Address = [0x0f, 0x0f, 0x00];
export const ADDR_COMMON: Address = [0x30, 0x00, 0x00];
export const ADDR_SYSTEM: Address = [0x00, 0x00, 0x00];
export const opAddress = (index: number): Address => [0x31, index, 0x00];
export const SYSTEM_SIZE = 32;

/** spec §1.5: makes the low 7 bits of model+address+data+checksum zero. */
export function checksum(bytes: Iterable<number>): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return -sum & 0x7f;
}

export function buildParamChange(address: Address, data: Bytes): Bytes {
  return [...PREFIX, 0x10, ...GROUP, MODEL, ...address, ...data, 0xf7];
}

export function buildDumpRequest(address: Address): Bytes {
  return [...PREFIX, 0x20, ...GROUP, MODEL, ...address, 0xf7];
}

export function buildBulk(address: Address, data: Bytes): Bytes {
  const count = data.length + 4;
  return [...PREFIX, 0x00, ...GROUP, count >> 7, count & 0x7f, MODEL, ...address, ...data,
    checksum([MODEL, ...address, ...data]), 0xf7];
}

export interface BulkBlock {
  address: Address;
  data: Bytes;
}

/** Parse one bulk-dump message; returns null if it is not a reface DX bulk message. Throws on corruption. */
export function parseBulk(msg: Bytes): BulkBlock | null {
  // Device byte (0n) is ignored on input: spec §1.4, replies always carry 00 but the spec says not to rely on it.
  if (msg.length < 13 || msg[0] !== 0xf0 || msg[1] !== 0x43 || (msg[2] & 0xf0) !== 0x00 ||
      msg[3] !== 0x7f || msg[4] !== 0x1c || msg[7] !== MODEL) return null;
  if (msg[msg.length - 1] !== 0xf7) throw new Error('bulk message not terminated by F7');
  const count = (msg[5] << 7) | msg[6];
  const body = msg.slice(7, msg.length - 2); // model + address + data (spec §1.4: count = N + 4)
  if (count !== body.length) {
    throw new Error(`bulk byte count ${count} does not match length ${body.length}`);
  }
  if (checksum(msg.slice(7, msg.length - 1)) !== 0) throw new Error('bulk checksum mismatch');
  return { address: [body[1], body[2], body[3]], data: body.slice(4) };
}

const sameAddr = (a: Address, b: Address) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
export const isFooter = (block: BulkBlock) => sameAddr(block.address, ADDR_FOOTER);
export const isHeader = (block: BulkBlock) => sameAddr(block.address, ADDR_HEADER);

/** Decode the 7 messages of a voice dump (header, common, op1..4, footer). Throws if incomplete/malformed. */
export function parseVoiceDump(messages: Bytes[]): VoiceData {
  const blocks = messages.map((m) => {
    const b = parseBulk(m);
    if (!b) throw new Error('not a reface DX bulk message');
    return b;
  });
  if (blocks.length !== 7 || !isHeader(blocks[0]) || !isFooter(blocks[6])) {
    throw new Error(`voice dump must be header + 5 blocks + footer, got ${blocks.length} messages`);
  }
  const expect = (b: BulkBlock, addr: Address, size: number) => {
    if (!sameAddr(b.address, addr) || b.data.length !== size) {
      throw new Error(`unexpected block ${toHex(b.address)} (${b.data.length} bytes), wanted ${toHex(addr)} (${size})`);
    }
    return b.data;
  };
  return {
    common: expect(blocks[1], ADDR_COMMON, COMMON_SIZE),
    ops: [0, 1, 2, 3].map((i) => expect(blocks[2 + i], opAddress(i), OP_SIZE)),
  };
}

/** The 7 messages that write a whole voice into the edit buffer (same layout the device dumps). */
export function buildVoiceDump(voice: VoiceData): Bytes[] {
  return [
    buildBulk(ADDR_HEADER, []),
    buildBulk(ADDR_COMMON, voice.common),
    ...voice.ops.map((op, i) => buildBulk(opAddress(i), op)),
    buildBulk(ADDR_FOOTER, []),
  ];
}

/** One parameter-change message per byte of the param (name = 10 messages, one per character). */
export function paramChanges(def: ParamDef, value: ParamValue): { address: Address; message: Bytes }[] {
  const base = def.block === 'common' ? ADDR_COMMON : opAddress(def.op! - 1);
  return encodeValue(def, value).map((byte, i) => {
    const address: Address = [base[0], base[1], def.offset + i];
    return { address, message: buildParamChange(address, [byte]) };
  });
}

/** Byte-level equality of two voices (common + 4 ops, reserved bytes included). */
export function voicesEqual(a: VoiceData, b: VoiceData): boolean {
  return a.common.every((v, i) => v === b.common[i]) && a.ops.every((op, n) => op.every((v, i) => v === b.ops[n][i]));
}

export const toHex = (bytes: Iterable<number>) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export function fromHex(text: string): Bytes {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('odd number of hex digits');
  return clean.match(/../g)!.map((h) => parseInt(h, 16));
}

/** Split a .syx byte stream into F0..F7 messages. */
export function splitSysex(bytes: Iterable<number>): Bytes[] {
  const out: Bytes[] = [];
  let cur: Bytes | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { out.push(cur); cur = null; }
    }
  }
  return out;
}

// FM-section Control Changes (spec §6.3); only sent/received by the DX when System "MIDI Control" is ON.
const OP_CC_BASE = [85, 102, 108, 114];
const OP_CC_FIELDS = ['level', 'feedback', 'feedbackType', 'freqMode', 'coarse', 'fine'];
const ALGO_CC_MIN = [0, 12, 22, 33, 43, 54, 65, 75, 86, 96, 107, 117];

/** Map an incoming CC to a display-domain param value, or null if it is not an FM-section CC. */
export function ccToValues(controller: number, value: number): Record<string, ParamValue> | null {
  if (controller === 80) return { algorithm: ALGO_CC_MIN.filter((min) => value >= min).length };
  const n = OP_CC_BASE.findIndex((base) => controller >= base && controller < base + OP_CC_FIELDS.length);
  if (n < 0) return null;
  const field = OP_CC_FIELDS[controller - OP_CC_BASE[n]];
  const mapped = field === 'feedbackType' ? (value < 64 ? 'SAW' : 'SQUARE')
    : field === 'freqMode' ? (value < 64 ? 'RATIO' : 'FIXED') : value;
  return { [`op${n + 1}.${field}`]: mapped };
}
