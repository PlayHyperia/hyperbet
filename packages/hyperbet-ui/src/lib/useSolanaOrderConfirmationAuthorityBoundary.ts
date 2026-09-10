import { useLayoutEffect, useRef } from "react";

type SolanaOrderConfirmationAuthorityBoundaryInput = {
  tradingEnabled: boolean;
  confirmationOpen: boolean;
  onInvalidate: () => void;
};

export type SolanaWagerAuthorityEpoch = Readonly<{
  sequence: number;
}>;

export type SolanaWagerAuthorityBoundary = Readonly<{
  update: (tradingEnabled: boolean) => void;
  capture: () => SolanaWagerAuthorityEpoch | null;
  assertCurrent: (epoch: SolanaWagerAuthorityEpoch) => void;
}>;

export class SolanaWagerAuthorityChangedError extends Error {
  constructor() {
    super("Trading authority changed; review the refreshed quote");
    this.name = "SolanaWagerAuthorityChangedError";
  }
}

export function createSolanaWagerAuthorityBoundary(
  initiallyEnabled: boolean,
): SolanaWagerAuthorityBoundary {
  let enabled = initiallyEnabled;
  let sequence = 0;
  let currentEpoch: SolanaWagerAuthorityEpoch = Object.freeze({ sequence });

  return Object.freeze({
    update(nextEnabled: boolean) {
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      sequence += 1;
      currentEpoch = Object.freeze({ sequence });
    },
    capture() {
      return enabled ? currentEpoch : null;
    },
    assertCurrent(epoch: SolanaWagerAuthorityEpoch) {
      if (!enabled || epoch !== currentEpoch) {
        throw new SolanaWagerAuthorityChangedError();
      }
    },
  });
}

export async function runSolanaWagerPreBroadcastFlow<TSigned, TResult>(input: {
  authority: SolanaWagerAuthorityBoundary;
  epoch: SolanaWagerAuthorityEpoch;
  requestSignature: () => Promise<TSigned>;
  startBroadcast: (signed: TSigned) => Promise<TResult>;
}): Promise<TResult> {
  input.authority.assertCurrent(input.epoch);
  const signed = await input.requestSignature();
  input.authority.assertCurrent(input.epoch);
  return input.startBroadcast(signed);
}

export function restoreSolanaOrderConfirmationFocus(
  returnFocusTarget: HTMLElement | null,
  fallbackTarget: HTMLElement | null,
): void {
  if (returnFocusTarget?.isConnected) {
    returnFocusTarget.focus();
  } else if (fallbackTarget?.isConnected) {
    fallbackTarget.focus();
  }
}

export function useInvalidateSolanaOrderConfirmationOnTradingDisabled({
  tradingEnabled,
  confirmationOpen,
  onInvalidate,
}: SolanaOrderConfirmationAuthorityBoundaryInput): SolanaWagerAuthorityBoundary {
  const previousTradingEnabledRef = useRef(tradingEnabled);
  const invalidateRef = useRef(onInvalidate);
  const authorityBoundaryRef = useRef<SolanaWagerAuthorityBoundary | null>(
    null,
  );
  if (authorityBoundaryRef.current === null) {
    authorityBoundaryRef.current =
      createSolanaWagerAuthorityBoundary(tradingEnabled);
  }
  invalidateRef.current = onInvalidate;

  useLayoutEffect(() => {
    const tradingAuthorityWasLost =
      previousTradingEnabledRef.current && !tradingEnabled;
    previousTradingEnabledRef.current = tradingEnabled;
    authorityBoundaryRef.current?.update(tradingEnabled);
    if (tradingAuthorityWasLost && confirmationOpen) invalidateRef.current();
  }, [confirmationOpen, tradingEnabled]);

  return authorityBoundaryRef.current;
}
