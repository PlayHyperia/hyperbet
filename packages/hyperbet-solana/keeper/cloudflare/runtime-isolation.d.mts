export function readProcessIdentity(pid?: number): { parent: number; group: number; session: number };
export function failurePath(ownerId?: string): string;
export function assertRuntimeIsolation(): number;
export function failClosed(error: unknown): never;
