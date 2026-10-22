export type StorageExecute = (
  requestId: string,
  operation: string,
  args: unknown[],
  fingerprint: string,
  ownerId: string,
) => unknown;

export function validateOperation(operation: unknown, args: unknown): boolean;
export function handleStorageRequest(request: Request, options: {
  token: string;
  execute: StorageExecute;
}): Promise<Response>;
