import { hashAction } from "./evidence";

export interface CapabilityBitmap {
  catalogHash: string;
  bitLength: number;
  bytes: Uint8Array;
}

export interface EncodedBitmap {
  catalogHash: string;
  bitLength: number;
  encoding: "base64-lsb0";
  data: string;
}

function byteLengthFor(bitLength: number): number {
  return Math.ceil(bitLength / 8);
}

function validateBitmap(bm: CapabilityBitmap, op: string): void {
  if (typeof bm.catalogHash !== "string" || bm.catalogHash.length === 0) {
    throw new Error(`${op}: bitmap has invalid catalogHash`);
  }
  if (!Number.isInteger(bm.bitLength) || bm.bitLength < 0) {
    throw new Error(`${op}: bitmap bitLength must be a non-negative integer, got ${bm.bitLength}`);
  }
  if (!(bm.bytes instanceof Uint8Array) || bm.bytes.length !== byteLengthFor(bm.bitLength)) {
    throw new Error(
      `${op}: byte length ${bm.bytes.length} inconsistent with bitLength ${bm.bitLength} (expected ${byteLengthFor(bm.bitLength)})`,
    );
  }
}

function assertOperandCompatibility(a: CapabilityBitmap, b: CapabilityBitmap, op: string): void {
  if (a.catalogHash !== b.catalogHash) {
    throw new Error(`${op}: catalogHash mismatch ("${a.catalogHash}" vs "${b.catalogHash}")`);
  }
  if (a.bitLength !== b.bitLength) {
    throw new Error(`${op}: bitLength mismatch (${a.bitLength} vs ${b.bitLength})`);
  }
}

function assertIndex(bm: CapabilityBitmap, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= bm.bitLength) {
    throw new RangeError(`index ${index} out of range for bitLength ${bm.bitLength}`);
  }
}

export function createBitmap(catalogHash: string, bitLength: number): CapabilityBitmap {
  if (!Number.isInteger(bitLength) || bitLength < 0) {
    throw new RangeError(`bitLength must be a non-negative integer, got ${bitLength}`);
  }
  if (typeof catalogHash !== "string" || catalogHash.length === 0) {
    throw new Error("catalogHash must be a non-empty string");
  }
  return { catalogHash, bitLength, bytes: new Uint8Array(byteLengthFor(bitLength)) };
}

export function cloneBitmap(bm: CapabilityBitmap): CapabilityBitmap {
  validateBitmap(bm, "cloneBitmap");
  return { catalogHash: bm.catalogHash, bitLength: bm.bitLength, bytes: bm.bytes.slice() };
}

export function setBit(bm: CapabilityBitmap, index: number): void {
  validateBitmap(bm, "setBit");
  assertIndex(bm, index);
  bm.bytes[index >> 3]! |= 1 << (index & 7);
}

export function clearBit(bm: CapabilityBitmap, index: number): void {
  validateBitmap(bm, "clearBit");
  assertIndex(bm, index);
  bm.bytes[index >> 3]! &= ~(1 << (index & 7)) & 0xff;
}

export function getBit(bm: CapabilityBitmap, index: number): boolean {
  validateBitmap(bm, "getBit");
  assertIndex(bm, index);
  return (bm.bytes[index >> 3]! & (1 << (index & 7))) !== 0;
}

export function popcount(bm: CapabilityBitmap): number {
  validateBitmap(bm, "popcount");
  let count = 0;
  for (const byte of bm.bytes) {
    let v = byte;
    while (v) {
      v &= v - 1;
      count++;
    }
  }
  return count;
}

export function isEmpty(bm: CapabilityBitmap): boolean {
  validateBitmap(bm, "isEmpty");
  return bm.bytes.every((b) => b === 0);
}

export function isFull(bm: CapabilityBitmap): boolean {
  validateBitmap(bm, "isFull");
  // bitLength 0 is vacuously full; ops on it are no-ops (empty catalog edge case).
  const fullBytes = bm.bitLength >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (bm.bytes[i] !== 0xff) return false;
  }
  const rem = bm.bitLength & 7;
  if (rem !== 0) {
    const mask = (1 << rem) - 1;
    if ((bm.bytes[fullBytes]! & mask) !== mask) return false;
  }
  return true;
}

function zipOp(a: CapabilityBitmap, b: CapabilityBitmap, op: string, f: (x: number, y: number) => number): CapabilityBitmap {
  validateBitmap(a, op);
  validateBitmap(b, op);
  assertOperandCompatibility(a, b, op);
  const bytes = new Uint8Array(a.bytes.length);
  for (let i = 0; i < a.bytes.length; i++) {
    bytes[i] = f(a.bytes[i]!, b.bytes[i]!) & 0xff;
  }
  return { catalogHash: a.catalogHash, bitLength: a.bitLength, bytes };
}

export function union(a: CapabilityBitmap, b: CapabilityBitmap): CapabilityBitmap {
  return zipOp(a, b, "union", (x, y) => x | y);
}

export function intersection(a: CapabilityBitmap, b: CapabilityBitmap): CapabilityBitmap {
  return zipOp(a, b, "intersection", (x, y) => x & y);
}

export function difference(a: CapabilityBitmap, b: CapabilityBitmap): CapabilityBitmap {
  return zipOp(a, b, "difference", (x, y) => x & ~y);
}

export function equality(a: CapabilityBitmap, b: CapabilityBitmap): boolean {
  validateBitmap(a, "equality");
  validateBitmap(b, "equality");
  if (a.catalogHash !== b.catalogHash || a.bitLength !== b.bitLength) return false;
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i] !== b.bytes[i]) return false;
  }
  return true;
}

export function toIds(bm: CapabilityBitmap, catalog: readonly { id: string }[]): string[] {
  validateBitmap(bm, "toIds");
  if (bm.bitLength !== catalog.length) {
    throw new Error(`toIds: bitmap bitLength ${bm.bitLength} does not match catalog length ${catalog.length}`);
  }
  const ids: string[] = [];
  for (let i = 0; i < bm.bitLength; i++) {
    if (getBit(bm, i)) ids.push(catalog[i]!.id);
  }
  return ids;
}

export function fromIds(ids: readonly string[], catalog: readonly { id: string }[], catalogHash: string): CapabilityBitmap {
  const bm = createBitmap(catalogHash, catalog.length);
  const indexById = new Map(catalog.map((entry, i) => [entry.id, i] as const));
  for (const id of ids) {
    const index = indexById.get(id);
    if (index === undefined) {
      throw new Error(`fromIds: id "${id}" not present in catalog`);
    }
    setBit(bm, index);
  }
  return bm;
}

export function encodeBitmap(bm: CapabilityBitmap): EncodedBitmap {
  validateBitmap(bm, "encodeBitmap");
  return {
    catalogHash: bm.catalogHash,
    bitLength: bm.bitLength,
    encoding: "base64-lsb0",
    data: Buffer.from(bm.bytes).toString("base64"),
  };
}

export function decodeBitmap(enc: EncodedBitmap): CapabilityBitmap {
  if (enc.encoding !== "base64-lsb0") {
    throw new Error(`decodeBitmap: unsupported encoding "${String(enc.encoding)}"`);
  }
  if (!Number.isInteger(enc.bitLength) || enc.bitLength < 0) {
    throw new Error(`decodeBitmap: invalid bitLength ${String(enc.bitLength)}`);
  }
  const bytes = new Uint8Array(Buffer.from(enc.data, "base64"));
  const expected = byteLengthFor(enc.bitLength);
  if (bytes.length !== expected) {
    throw new Error(`decodeBitmap: decoded ${bytes.length} bytes, expected ${expected} for bitLength ${enc.bitLength}`);
  }
  const rem = enc.bitLength & 7;
  if (rem !== 0) {
    const mask = (1 << rem) - 1;
    if ((bytes[bytes.length - 1]! & ~mask & 0xff) !== 0) {
      throw new Error("decodeBitmap: nonzero padding bits in final byte");
    }
  }
  return { catalogHash: enc.catalogHash, bitLength: enc.bitLength, bytes };
}
