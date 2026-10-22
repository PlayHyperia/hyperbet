export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class StorageTransportError extends Error {
  readonly code: string;
  readonly requestId?: string;
  constructor(code: string, requestId?: string);
}

export function createStorageTransport(options: {
  url: string;
  token: string;
  ownerId: string;
  timeoutMs?: number;
}): {
  call(operation: string, args: JsonValue[]): unknown;
  close(): Promise<void>;
};
