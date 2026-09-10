import { useCallback, useLayoutEffect, useRef } from "react";

export type SolanaTransactionContextToken = Readonly<{
  contextKey: string;
}>;

export type IsCurrentSolanaTransactionContext = (
  capturedContext: SolanaTransactionContextToken | null,
) => capturedContext is SolanaTransactionContextToken;

export type SolanaTransactionContextBoundary = {
  currentContext: SolanaTransactionContextToken | null;
  isCurrentContext: IsCurrentSolanaTransactionContext;
};

export type SolanaTransactionContextLock = {
  current: SolanaTransactionContextToken | null;
};

export function releaseSolanaTransactionContextLock(
  lock: SolanaTransactionContextLock,
  owner: SolanaTransactionContextToken,
): boolean {
  if (lock.current !== owner) return false;
  lock.current = null;
  return true;
}

/**
 * Runs a synchronous reset before paint whenever the mounted transaction
 * identity changes. The first render establishes identity without clearing
 * state; later wallet disconnect/connect and duel/market rollover transitions
 * are all explicit boundaries.
 */
export function useSolanaTransactionContextBoundary(
  contextKey: string | null,
  reset: () => void,
): SolanaTransactionContextBoundary {
  const boundaryContextRef = useRef<string | null | undefined>(undefined);
  const tokenRef = useRef<{
    contextKey: string | null;
    token: SolanaTransactionContextToken | null;
  } | null>(null);
  if (tokenRef.current?.contextKey !== contextKey) {
    tokenRef.current = {
      contextKey,
      token: contextKey === null ? null : Object.freeze({ contextKey }),
    };
  }
  const currentContext = tokenRef.current.token;
  const currentContextRef = useRef(currentContext);
  const resetRef = useRef(reset);
  currentContextRef.current = currentContext;
  resetRef.current = reset;

  useLayoutEffect(() => {
    if (boundaryContextRef.current === undefined) {
      boundaryContextRef.current = contextKey;
      return;
    }
    if (boundaryContextRef.current === contextKey) return;

    boundaryContextRef.current = contextKey;
    resetRef.current();
  }, [contextKey]);

  const isCurrentContext = useCallback<IsCurrentSolanaTransactionContext>(
    (
      capturedContext: SolanaTransactionContextToken | null,
    ): capturedContext is SolanaTransactionContextToken =>
      capturedContext !== null && currentContextRef.current === capturedContext,
    [],
  );

  return { currentContext, isCurrentContext };
}
