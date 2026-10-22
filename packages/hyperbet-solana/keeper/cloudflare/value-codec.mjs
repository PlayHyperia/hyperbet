// Tag every structured value so ordinary records cannot collide with Map/Set
// envelopes. Undefined is needed for the pinned functions' optional arguments.
export function encodeValue(value, ancestors = new Set()) {
  if (value === undefined) return { type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Unsupported keeper storage value");
  ancestors.add(value);
  const encode = item => encodeValue(item, ancestors);
  let encoded;
  if (value instanceof Map) encoded = { type: "map", value: [...value].map(([key, item]) => [encode(key), encode(item)]) };
  else if (value instanceof Set) encoded = { type: "set", value: [...value].map(encode) };
  else if (Array.isArray(value)) encoded = { type: "array", value: Array.from(value, encode) };
  else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    encoded = { type: "object", value: Object.entries(value).map(([key, item]) => [key, encode(item)]) };
  } else throw new Error("Unsupported keeper storage value");
  ancestors.delete(value);
  return encoded;
}

export function decodeValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid keeper storage encoding");
  const keys = Object.keys(value).sort().join(",");
  if (value.type === "undefined" && keys === "type") return undefined;
  if (keys !== "type,value" || !Array.isArray(value.value)) throw new Error("Invalid keeper storage encoding");
  if (value.type === "array") return value.value.map(decodeValue);
  if (value.type === "set") {
    const items = value.value.map(decodeValue);
    const result = new Set(items);
    if (result.size !== items.length) throw new Error("Duplicate keeper set value");
    return result;
  }
  if (value.type === "map" || value.type === "object") {
    const entries = value.value.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 ||
          (value.type === "object" && typeof pair[0] !== "string")) throw new Error("Invalid keeper storage entry");
      return [value.type === "map" ? decodeValue(pair[0]) : pair[0], decodeValue(pair[1])];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Duplicate keeper storage key");
    return value.type === "map" ? new Map(entries) : Object.fromEntries(entries);
  }
  throw new Error("Invalid keeper storage encoding");
}
