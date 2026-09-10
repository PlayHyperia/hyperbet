import { describe, expect, test } from "bun:test";

import { decodeExactProgramDataEvents } from "./solanaProgramEvents";

describe("finalized SOL program-event decoding", () => {
  test("preserves every decoded event, duplicate, and log position", () => {
    const decoded = decodeExactProgramDataEvents(
      ["first", "second", "first"],
      (value) => ({ name: `event-${value}`, data: { value } }),
    );
    expect(decoded).toEqual([
      { name: "event-first", data: { value: "first" } },
      { name: "event-second", data: { value: "second" } },
      { name: "event-first", data: { value: "first" } },
    ]);
  });

  test("rejects undecodable, malformed, coercible, and hostile event logs", () => {
    const valid = () => ({ name: "event", data: {} });
    for (const [logs, decode] of [
      [null, valid],
      [{ 0: "data" }, valid],
      [[""], valid],
      [[1], valid],
      [["data"], () => null],
      [["data"], () => ({ name: "", data: {} })],
      [["data"], () => ({ name: "event", data: null })],
      [["data"], () => ({ name: "event", data: [] })],
      [
        ["data"],
        () => {
          throw new Error("hostile decoder");
        },
      ],
      [
        new Proxy(["data"], {
          get: () => {
            throw new Error("hostile logs");
          },
        }),
        valid,
      ],
    ] as const) {
      expect(() => decodeExactProgramDataEvents(logs, decode)).toThrow();
    }
  });
});
