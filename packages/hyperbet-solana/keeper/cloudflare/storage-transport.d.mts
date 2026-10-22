export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class StorageTransportError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function createStorageTransport(options: {
  url: string;
  token: string;
  timeoutMs?: number;
}): {
  call(operation: string, args: JsonValue[]): unknown;
  close(): Promise<void>;
};
