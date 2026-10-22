import assert from "node:assert/strict";
import { encodeValue, decodeValue } from "../value-codec.mjs";

const values = [undefined, null, true, 42.5, "wallet", [], {},
  new Map([["wallet", { points: 1, members: new Set(["a", "b"]) }]]),
  { type: "map", value: [["ordinary", "record"]] },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}'),
  [undefined, 100],
];
for (const value of values) {
  assert.deepEqual(decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))), value);
}
assert.equal({}.polluted, undefined);
for (const value of [NaN, Infinity, 1n, new Date(), () => {}]) {
  assert.throws(() => encodeValue(value), /Unsupported/);
}
const cyclic = {}; cyclic.self = cyclic;
assert.throws(() => encodeValue(cyclic), /Unsupported/);
for (const value of [{}, [], { type: "set", value: ["a", "a"] },
  { type: "object", value: [["a", 1], ["a", 2]] },
  { type: "map", value: [["a"]] }, { type: "undefined", value: [] },
  { type: "object", value: [[5, 1]] }]) {
  assert.throws(() => decodeValue(value));
}
console.log("Storage codec: nested collections, optional arguments, reserved keys, and malformed values passed");
