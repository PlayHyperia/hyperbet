import { describe, expect, test } from "bun:test";

import { lockModalDocumentScroll } from "../../src/spectator/modalAccessibility";

describe("spectator modal accessibility", () => {
  test("locks background scrolling and restores the exact prior policy", () => {
    const style = {
      overflow: "clip",
      overscrollBehavior: "contain",
    } as CSSStyleDeclaration;
    const body = { style } as HTMLElement;

    const unlock = lockModalDocumentScroll({ body });
    expect(body.style.overflow).toBe("hidden");
    expect(body.style.overscrollBehavior).toBe("none");

    unlock();
    expect(body.style.overflow).toBe("clip");
    expect(body.style.overscrollBehavior).toBe("contain");
  });

  test("restores an initially unset inline policy", () => {
    const style = {
      overflow: "",
      overscrollBehavior: "",
    } as CSSStyleDeclaration;
    const body = { style } as HTMLElement;
    const unlock = lockModalDocumentScroll({ body });

    unlock();
    expect(body.style.overflow).toBe("");
    expect(body.style.overscrollBehavior).toBe("");
  });
});
