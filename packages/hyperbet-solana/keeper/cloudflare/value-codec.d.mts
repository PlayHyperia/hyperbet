import type { JsonValue } from "./storage-transport.mjs";

export function encodeValue(value: unknown): JsonValue;
export function decodeValue(value: unknown): unknown;
