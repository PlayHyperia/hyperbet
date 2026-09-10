import "./setup";
import { describe, expect, it } from "bun:test";

import { SolanaOrderQuoteNotice } from "../src/components/SolanaOrderQuoteNotice";
import { getByTestId, render } from "./render";

function renderNotice(kind: "input" | "loading" | "status" | "error") {
  const { container } = render(
    <SolanaOrderQuoteNotice kind={kind} message={`${kind} message`} />,
  );
  return getByTestId(container, "solana-order-quote-notice");
}

describe("SolanaOrderQuoteNotice", () => {
  it("does not duplicate the field-owned live announcement for input errors", () => {
    const notice = renderNotice("input");

    expect(notice.getAttribute("data-kind")).toBe("input");
    expect(notice.getAttribute("role")).toBeNull();
    expect(notice.getAttribute("aria-live")).toBeNull();
    expect(notice.getAttribute("aria-busy")).toBeNull();
    expect(notice.style.color).toBe("#fca5a5");
  });

  it("announces quote calculation as polite busy status instead of an error", () => {
    const notice = renderNotice("loading");

    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.getAttribute("aria-atomic")).toBe("true");
    expect(notice.getAttribute("aria-busy")).toBe("true");
    expect(notice.style.color).toBe("#bfdbfe");
  });

  it("announces expected setup state politely without claiming work is busy", () => {
    const notice = renderNotice("status");

    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.getAttribute("aria-busy")).toBeNull();
    expect(notice.style.color).toBe("#fde68a");
  });

  it("announces funding and quote failures assertively", () => {
    const notice = renderNotice("error");

    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.getAttribute("aria-live")).toBe("assertive");
    expect(notice.getAttribute("aria-atomic")).toBe("true");
    expect(notice.getAttribute("aria-busy")).toBeNull();
    expect(notice.style.color).toBe("#fca5a5");
  });
});
