import test from "node:test";
import assert from "node:assert/strict";
import { compatibleContextOffset, patchProviderContextBytes } from "../src/provider-core-context.mjs";

const TEXT = 0x400;
const RDATA = 0x800;
const PDATA = 0xc00;
const CTOR = TEXT + 0x90;
const PATCH = CTOR + 27;
const WARNING = RDATA + 0x20;
const OPTIONAL = 0x80 + 24;
const SECTION_HEADERS = OPTIONAL + 0xf0;
const RDATA_HEADER = SECTION_HEADERS + 40;
const PDATA_HEADER = SECTION_HEADERS + 80;
const ctor = Buffer.from("48c7060100000048c746088026040048c746100100000048c746188026040048c7462000000000", "hex");
const reserve = Buffer.from("48899e9009000048c786180a00005f000000", "hex");
const marker = Buffer.from("Unknown model x is used. This will use fallback model metadata.\0models-manager\\src\\model_info.rs\0");

function fakeCore() {
  const bytes = Buffer.alloc(0xe00);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  const pe = 0x80, optional = pe + 24;
  bytes.write("PE\0\0", pe);
  bytes.writeUInt16LE(0x8664, pe + 4);
  bytes.writeUInt16LE(3, pe + 6);
  bytes.writeUInt16LE(0xf0, pe + 20);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x3000, optional + 112 + 3 * 8);
  bytes.writeUInt32LE(12, optional + 116 + 3 * 8);
  const sections = optional + 0xf0;
  for (const [index, name, rva, raw, flags] of [
    [0, ".text", 0x1000, TEXT, 0x60000020],
    [1, ".rdata", 0x2000, RDATA, 0x40000040],
    [2, ".pdata", 0x3000, PDATA, 0x40000040],
  ]) {
    const at = sections + index * 40;
    bytes.write(name, at);
    bytes.writeUInt32LE(0x400, at + 8);
    bytes.writeUInt32LE(rva, at + 12);
    bytes.writeUInt32LE(0x400, at + 16);
    bytes.writeUInt32LE(raw, at + 20);
    bytes.writeUInt32LE(flags, at + 36);
  }
  // The .pdata function encloses the constructor and references its warning.
  bytes.writeUInt32LE(0x1010, PDATA);
  bytes.writeUInt32LE(0x1200, PDATA + 4);
  const lea = TEXT + 0x20;
  bytes.set([0x48, 0x8d, 0x05], lea);
  bytes.writeInt32LE(0x2020 - (0x1020 + 7), lea + 3);
  ctor.copy(bytes, CTOR);
  reserve.copy(bytes, CTOR + ctor.length);
  marker.copy(bytes, WARNING);
  return bytes;
}

test("recognizes only the intended four-byte max-context immediate", () => {
  const source = fakeCore();
  const original = Buffer.from(source);
  assert.equal(compatibleContextOffset(source), PATCH);
  const patched = patchProviderContextBytes(source, { allowCompatible: true });
  assert.deepEqual(source, original);
  assert.equal(patched.readUInt32LE(PATCH), 10_000_000);
  assert.equal(source.readUInt32LE(PATCH), 272_000);
  assert.deepEqual(patched.subarray(0, PATCH), source.subarray(0, PATCH));
  assert.deepEqual(patched.subarray(PATCH + 4), source.subarray(PATCH + 4));
  assert.equal(compatibleContextOffset(patched), null);
  assert.throws(() => patchProviderContextBytes(patched, { allowCompatible: true }), /updated custom context patch/);
});

test("rejects malformed or truncated PE data", () => {
  const source = fakeCore();
  const cases = [
    Buffer.alloc(0), source.subarray(0, 64), source.subarray(0, CTOR + 10),
    source.subarray(0, PDATA + 4),
    (() => { const b = Buffer.from(source); b.writeUInt32LE(0xfffffff0, 0x3c); return b; })(),
    (() => { const b = Buffer.from(source); b.writeUInt32LE(0xfffffff0, 0x98 + 112 + 3 * 8); return b; })(),
  ];
  for (const bytes of cases) {
    assert.equal(compatibleContextOffset(bytes), null);
    assert.throws(() => patchProviderContextBytes(bytes, { allowCompatible: true }), /updated custom context patch/);
  }
});

test("rejects duplicate constructors and missing function enclosure", () => {
  const duplicate = fakeCore();
  ctor.copy(duplicate, TEXT + 0x150);
  assert.equal(compatibleContextOffset(duplicate), null);
  const noPdata = fakeCore();
  noPdata.writeUInt32LE(0, 0x98 + 112 + 3 * 8);
  assert.equal(compatibleContextOffset(noPdata), null);
  const wrongFunction = fakeCore();
  wrongFunction.writeUInt32LE(0x1080, PDATA + 4);
  assert.equal(compatibleContextOffset(wrongFunction), null);
  const noWarningXref = fakeCore();
  noWarningXref.fill(0, TEXT + 0x20, TEXT + 0x27);
  assert.equal(compatibleContextOffset(noWarningXref), null);
});

test("rejects changed defaults, reserve, warning, or source marker", () => {
  for (const mutate of [
    b => b.writeUInt32LE(131_072, CTOR + 11),
    b => b.writeUInt32LE(94, PATCH + 26),
    b => b.write("Not a model", WARNING),
    b => b.write("other-manager", WARNING + marker.indexOf("models-manager")),
  ]) {
    const bytes = fakeCore();
    mutate(bytes);
    assert.equal(compatibleContextOffset(bytes), null);
  }
});

test("requires a readable nonexecutable nonwritable marker within its section", () => {
  for (const flags of [0x60000020, 0xc0000040, 0x00000040]) {
    const bytes = fakeCore();
    bytes.writeUInt32LE(flags, RDATA_HEADER + 36);
    assert.equal(compatibleContextOffset(bytes), null);
  }
  const markerCrossesSection = fakeCore();
  markerCrossesSection.writeUInt32LE(0x60, RDATA_HEADER + 16);
  assert.equal(compatibleContextOffset(markerCrossesSection), null);
});

test("requires a readable nonexecutable nonwritable exception table within its section", () => {
  for (const flags of [0x60000020, 0xc0000040, 0x00000040]) {
    const bytes = fakeCore();
    bytes.writeUInt32LE(flags, PDATA_HEADER + 36);
    assert.equal(compatibleContextOffset(bytes), null);
  }
  const exceptionCrossesSection = fakeCore();
  exceptionCrossesSection.writeUInt32LE(8, PDATA_HEADER + 16);
  assert.equal(compatibleContextOffset(exceptionCrossesSection), null);
});
