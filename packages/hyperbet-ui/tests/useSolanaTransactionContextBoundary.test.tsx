import "./setup";
import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { useRef, useState } from "react";

import { buildSolanaTransactionContextKey } from "../src/lib/solanaTransactionFeedback";
import {
  releaseSolanaTransactionContextLock,
  type SolanaTransactionContextToken,
  useSolanaTransactionContextBoundary,
} from "../src/lib/useSolanaTransactionContextBoundary";
import { click, getByTestId, render } from "./render";

const key = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed));
const BASE_CONTEXT = {
  cluster: "devnet" as const,
  rpcEndpoint: "https://rpc.example.test",
  fightOracleProgramId: key(8),
  duelMarketProgramId: key(9),
  walletAddress: key(1),
  duelKeyHex: "aa".repeat(32),
  advertisedMarketAddress: key(2),
  loadedMarketAddress: key(2),
};

function transactionContext(
  overrides: Partial<typeof BASE_CONTEXT> = {},
): string {
  const context = buildSolanaTransactionContextKey({
    ...BASE_CONTEXT,
    ...overrides,
  });
  if (!context) throw new Error("Test transaction context must be valid");
  return context;
}

function ContextHarness({
  initialContext,
  nextContext,
}: {
  initialContext: string | null;
  nextContext: string | null;
}) {
  const [context, setContext] = useState(initialContext);
  const [feedback, setFeedback] = useState("prior receipt");
  const { currentContext, isCurrentContext } =
    useSolanaTransactionContextBoundary(context, () => {
      setFeedback("idle");
    });
  const capturedInitialContext = useRef<
    SolanaTransactionContextToken | null | undefined
  >(undefined);
  if (capturedInitialContext.current === undefined) {
    capturedInitialContext.current = currentContext;
  }

  return (
    <>
      <div data-testid="context">{context ?? "disconnected"}</div>
      <div data-testid="feedback">{feedback}</div>
      <div data-testid="initial-current">
        {isCurrentContext(capturedInitialContext.current) ? "yes" : "no"}
      </div>
      <button
        data-testid="change-context"
        onClick={() => setContext(nextContext)}
      >
        Change
      </button>
    </>
  );
}

function ReturningContextHarness() {
  const initialContext = transactionContext();
  const [context, setContext] = useState<string | null>(initialContext);
  const { currentContext, isCurrentContext } =
    useSolanaTransactionContextBoundary(context, () => undefined);
  const capturedInitialContext = useRef(currentContext).current;

  return (
    <>
      <div data-testid="captured-current">
        {isCurrentContext(capturedInitialContext) ? "yes" : "no"}
      </div>
      <button
        data-testid="change-context"
        onClick={() =>
          setContext((current) => (current === null ? initialContext : null))
        }
      >
        Change
      </button>
    </>
  );
}

describe("Solana transaction context boundary", () => {
  test("establishes the first identity without erasing current state", () => {
    const { container } = render(
      <ContextHarness
        initialContext="wallet-a:duel:a"
        nextContext="wallet-a:duel:b"
      />,
    );

    expect(getByTestId(container, "feedback").textContent).toBe(
      "prior receipt",
    );
  });

  test("clears feedback synchronously when the duel identity changes", () => {
    const { container } = render(
      <ContextHarness
        initialContext="wallet-a:duel:a"
        nextContext="wallet-a:duel:b"
      />,
    );

    click(getByTestId(container, "change-context"));

    expect(getByTestId(container, "context").textContent).toBe(
      "wallet-a:duel:b",
    );
    expect(getByTestId(container, "feedback").textContent).toBe("idle");
    expect(getByTestId(container, "initial-current").textContent).toBe("no");
  });

  test("clears prior-wallet feedback on disconnect", () => {
    const { container } = render(
      <ContextHarness initialContext="wallet-a:duel:a" nextContext={null} />,
    );

    click(getByTestId(container, "change-context"));

    expect(getByTestId(container, "context").textContent).toBe("disconnected");
    expect(getByTestId(container, "feedback").textContent).toBe("idle");
  });

  test("treats first wallet connection after mount as a clean boundary", () => {
    const { container } = render(
      <ContextHarness initialContext={null} nextContext="wallet-a:duel:a" />,
    );

    click(getByTestId(container, "change-context"));

    expect(getByTestId(container, "context").textContent).toBe(
      "wallet-a:duel:a",
    );
    expect(getByTestId(container, "feedback").textContent).toBe("idle");
  });

  test("never treats a missing transaction identity as current", () => {
    const { container } = render(
      <ContextHarness initialContext={null} nextContext={null} />,
    );

    expect(getByTestId(container, "initial-current").textContent).toBe("no");
  });

  test("never revives an old callback after leaving and returning to the same identity", () => {
    const { container } = render(<ReturningContextHarness />);

    click(getByTestId(container, "change-context"));
    click(getByTestId(container, "change-context"));

    expect(getByTestId(container, "captured-current").textContent).toBe("no");
  });

  test("never lets an old finalizer release a newer same-identity operation", () => {
    const oldOwner = Object.freeze({ contextKey: transactionContext() });
    const currentOwner = Object.freeze({ contextKey: transactionContext() });
    const lock = { current: currentOwner };

    expect(releaseSolanaTransactionContextLock(lock, oldOwner)).toBe(false);
    expect(lock.current).toBe(currentOwner);
    expect(releaseSolanaTransactionContextLock(lock, currentOwner)).toBe(true);
    expect(lock.current).toBeNull();
  });

  test("invalidates an in-flight callback when deployment authority changes", () => {
    const initialContext = transactionContext();
    const { container } = render(
      <ContextHarness
        initialContext={initialContext}
        nextContext={transactionContext({ fightOracleProgramId: key(10) })}
      />,
    );

    click(getByTestId(container, "change-context"));

    expect(getByTestId(container, "feedback").textContent).toBe("idle");
    expect(getByTestId(container, "initial-current").textContent).toBe("no");
  });

  test("invalidates callbacks at both halves of a same-duel market replacement", () => {
    const initialContext = transactionContext();
    for (const nextContext of [
      transactionContext({ advertisedMarketAddress: key(3) }),
      transactionContext({ loadedMarketAddress: key(3) }),
    ]) {
      const { container } = render(
        <ContextHarness
          initialContext={initialContext}
          nextContext={nextContext}
        />,
      );

      click(getByTestId(container, "change-context"));

      expect(getByTestId(container, "feedback").textContent).toBe("idle");
      expect(getByTestId(container, "initial-current").textContent).toBe("no");
    }
  });
});
