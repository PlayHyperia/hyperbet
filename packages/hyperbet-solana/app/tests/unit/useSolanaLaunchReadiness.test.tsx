import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useSolanaLaunchReadiness } from "../../src/lib/useSolanaLaunchReadiness";

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function Harness({
  onState,
}: {
  onState: (state: { checked: boolean; ready: boolean }) => void;
}) {
  const state = useSolanaLaunchReadiness({
    pollIntervalMs: 50,
    requestTimeoutMs: 20,
  });
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

async function waitForState(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(predicate()).toBe(true);
}

describe("Solana launch readiness polling", () => {
  test("revokes prior readiness when the next request times out", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            service: "hyperbet-solana-backend",
            now: Date.now(),
            readiness: { ready: true },
          }),
        } as Response;
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("request aborted"));
        });
      });
    }) as typeof fetch;

    const observed: Array<{ checked: boolean; ready: boolean }> = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Harness onState={(state) => observed.push(state)} />);
    });

    await waitForState(
      () =>
        observed.at(-1)?.checked === true && observed.at(-1)?.ready === true,
    );
    expect(observed.at(-1)).toEqual({ checked: true, ready: true });

    await waitForState(
      () =>
        fetchCount >= 2 &&
        observed.at(-1)?.checked === true &&
        observed.at(-1)?.ready === false,
    );
    expect(observed.at(-1)).toEqual({ checked: true, ready: false });
  });
});
