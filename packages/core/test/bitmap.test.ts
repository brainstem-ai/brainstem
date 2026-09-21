import { describe, expect, test } from "vitest";
import {
  clearBit,
  cloneBitmap,
  createBitmap,
  decodeBitmap,
  difference,
  encodeBitmap,
  equality,
  fromIds,
  getBit,
  intersection,
  isEmpty,
  isFull,
  popcount,
  setBit,
  toIds,
  union,
  type CapabilityBitmap,
  type EncodedBitmap,
} from "../src/bitmap";

const H = "hash-a";
const H2 = "hash-b";

function seedRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setOf(bm: CapabilityBitmap): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < bm.bitLength; i++) if (getBit(bm, i)) s.add(i);
  return s;
}

describe("bitmap boundaries", () => {
  for (const bitLength of [1, 7, 8, 9, 31, 32, 33, 63, 64, 65]) {
    test(`bitLength ${bitLength}: set/clear/get every index`, () => {
      const bm = createBitmap(H, bitLength);
      expect(bm.bytes.length).toBe(Math.ceil(bitLength / 8));
      expect(popcount(bm)).toBe(0);
      for (let i = 0; i < bitLength; i++) {
        expect(getBit(bm, i)).toBe(false);
        setBit(bm, i);
        expect(getBit(bm, i)).toBe(true);
      }
      expect(popcount(bm)).toBe(bitLength);
      expect(isFull(bm)).toBe(true);
      expect(isEmpty(bm)).toBe(false);
      for (let i = 0; i < bitLength; i++) {
        clearBit(bm, i);
        expect(getBit(bm, i)).toBe(false);
      }
      expect(isEmpty(bm)).toBe(true);
    });
  }

  test("bitLength 0 is allowed and all ops are no-ops", () => {
    const bm = createBitmap(H, 0);
    expect(bm.bytes.length).toBe(0);
    expect(popcount(bm)).toBe(0);
    expect(isEmpty(bm)).toBe(true);
    expect(isFull(bm)).toBe(true);
    expect(toIds(bm, [])).toEqual([]);
    expect(union(bm, cloneBitmap(bm)).bitLength).toBe(0);
    const enc = encodeBitmap(bm);
    expect(decodeBitmap(enc)).toEqual(bm);
    expect(() => setBit(bm, 0)).toThrow(RangeError);
    expect(() => getBit(bm, 0)).toThrow(RangeError);
  });

  test("out-of-range indices throw RangeError", () => {
    const bm = createBitmap(H, 8);
    expect(() => getBit(bm, 8)).toThrow(RangeError);
    expect(() => setBit(bm, -1)).toThrow(RangeError);
    expect(() => clearBit(bm, 100)).toThrow(RangeError);
    expect(() => setBit(bm, 1.5)).toThrow(RangeError);
  });

  test("LSB0 ordering places bit 0 in the least significant position of byte 0", () => {
    const bm = createBitmap(H, 16);
    setBit(bm, 0);
    expect(bm.bytes[0]).toBe(0b0000_0001);
    setBit(bm, 7);
    expect(bm.bytes[0]).toBe(0b1000_0001);
    setBit(bm, 8);
    expect(bm.bytes[1]).toBe(0b0000_0001);
  });
});

describe("bitmap set algebra", () => {
  test("union, intersection, difference return new bitmaps", () => {
    const a = createBitmap(H, 16);
    setBit(a, 0);
    setBit(a, 9);
    const b = createBitmap(H, 16);
    setBit(b, 9);
    setBit(b, 15);
    const u = union(a, b);
    expect(getBit(u, 0)).toBe(true);
    expect(getBit(u, 9)).toBe(true);
    expect(getBit(u, 15)).toBe(true);
    expect(popcount(u)).toBe(3);
    const i = intersection(a, b);
    expect(popcount(i)).toBe(1);
    expect(getBit(i, 9)).toBe(true);
    const d = difference(a, b);
    expect(popcount(d)).toBe(1);
    expect(getBit(d, 0)).toBe(true);
    expect(a !== u && b !== u && a !== i).toBe(true);
    expect(popcount(a)).toBe(2);
  });

  test("equality", () => {
    const a = createBitmap(H, 33);
    setBit(a, 32);
    const b = cloneBitmap(a);
    expect(equality(a, b)).toBe(true);
    const c = createBitmap(H, 33);
    setBit(c, 31);
    expect(equality(a, c)).toBe(false);
    expect(equality(a, createBitmap(H2, 33))).toBe(false);
    expect(equality(a, createBitmap(H, 32))).toBe(false);
  });

  test("catalog mismatch between operands throws", () => {
    const a = createBitmap(H, 8);
    const b = createBitmap(H2, 8);
    expect(() => union(a, b)).toThrow(/catalogHash mismatch/);
    expect(() => intersection(a, b)).toThrow(/catalogHash mismatch/);
    expect(() => difference(a, b)).toThrow(/catalogHash mismatch/);
    expect(equality(a, b)).toBe(false);
  });

  test("bitLength mismatch between operands throws", () => {
    expect(() => union(createBitmap(H, 8), createBitmap(H, 9))).toThrow(/bitLength mismatch/);
  });

  test("inconsistent byte length throws", () => {
    const bad = { catalogHash: H, bitLength: 9, bytes: new Uint8Array(1) };
    expect(() => popcount(bad)).toThrow(/inconsistent/);
    expect(() => getBit(bad, 0)).toThrow(/inconsistent/);
  });

  test("toIds/fromIds round-trip and unknown id rejection", () => {
    const catalog = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const bm = fromIds(["c", "a"], catalog, H);
    expect(toIds(bm, catalog)).toEqual(["a", "c"]);
    expect(() => fromIds(["nope"], catalog, H)).toThrow(/not present in catalog/);
    expect(() => toIds(fromIds(["a"], catalog, H), [{ id: "a" }])).toThrow(/does not match/);
  });

  test("popcount/empty/full on partial final byte", () => {
    const bm = createBitmap(H, 10);
    setBit(bm, 8);
    setBit(bm, 9);
    setBit(bm, 0);
    expect(popcount(bm)).toBe(3);
    expect(isFull(bm)).toBe(false);
    const all = createBitmap(H, 10);
    for (let i = 0; i < 10; i++) setBit(all, i);
    expect(isFull(all)).toBe(true);
    clearBit(all, 9);
    expect(isFull(all)).toBe(false);
  });
});

describe("bitmap serialization", () => {
  test("round-trip", () => {
    const bm = createBitmap(H, 65);
    for (const i of [0, 1, 7, 8, 31, 32, 64]) setBit(bm, i);
    const enc = encodeBitmap(bm);
    expect(enc.encoding).toBe("base64-lsb0");
    expect(enc.catalogHash).toBe(H);
    expect(enc.bitLength).toBe(65);
    const dec = decodeBitmap(enc);
    expect(equality(dec, bm)).toBe(true);
    expect(dec.bytes).not.toBe(bm.bytes);
  });

  test("nonzero padding bits rejected on decode", () => {
    expect(() =>
      decodeBitmap({ catalogHash: H, bitLength: 9, encoding: "base64-lsb0", data: Buffer.from([0x01, 0x04]).toString("base64") }),
    ).toThrow(/padding/);
    expect(() =>
      decodeBitmap({ catalogHash: H, bitLength: 9, encoding: "base64-lsb0", data: Buffer.from([0x01, 0x01]).toString("base64") }),
    ).not.toThrow();
  });

  test("wrong byte length and encoding rejected on decode", () => {
    expect(() =>
      decodeBitmap({ catalogHash: H, bitLength: 9, encoding: "base64-lsb0", data: Buffer.from([0x01]).toString("base64") }),
    ).toThrow(/expected/);
    expect(() => decodeBitmap({ catalogHash: H, bitLength: 8, encoding: "hex" as EncodedBitmap["encoding"], data: "" })).toThrow(
      /encoding/,
    );
  });
});

describe("bitmap randomized set-equivalence", () => {
  test("1000 random ops match a Set<number> reference (seeded)", () => {
    const rand = seedRandom(0x5eed);
    const bitLength = 65;
    const bm = createBitmap(H, bitLength);
    const ref = new Set<number>();
    const randIndex = () => Math.floor(rand() * bitLength);
    for (let op = 0; op < 1000; op++) {
      const i = randIndex();
      const kind = op % 6;
      if (kind < 3) {
        setBit(bm, i);
        ref.add(i);
      } else if (kind < 5) {
        clearBit(bm, i);
        ref.delete(i);
      } else {
        expect(getBit(bm, i)).toBe(ref.has(i));
      }
      if (op % 100 === 0) {
        expect(popcount(bm)).toBe(ref.size);
        expect(setOf(bm)).toEqual(ref);
      }
    }
    expect(setOf(bm)).toEqual(ref);

    const bm2 = createBitmap(H, bitLength);
    const ref2 = new Set<number>();
    for (let op = 0; op < 500; op++) {
      const i = randIndex();
      if (rand() < 0.5) {
        setBit(bm2, i);
        ref2.add(i);
      } else {
        clearBit(bm2, i);
        ref2.delete(i);
      }
    }
    const u = union(bm, bm2);
    const expectedUnion = new Set([...ref, ...ref2]);
    expect(setOf(u)).toEqual(expectedUnion);
    const inter = intersection(bm, bm2);
    const expectedInter = new Set([...ref].filter((x) => ref2.has(x)));
    expect(setOf(inter)).toEqual(expectedInter);
    const diff = difference(bm, bm2);
    const expectedDiff = new Set([...ref].filter((x) => !ref2.has(x)));
    expect(setOf(diff)).toEqual(expectedDiff);
    const sameSet = ref.size === ref2.size && [...ref].every((x) => ref2.has(x));
    expect(equality(bm, bm2)).toBe(sameSet);
  });
});
