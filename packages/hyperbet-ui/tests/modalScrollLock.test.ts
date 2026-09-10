import { describe, expect, it } from "bun:test";

import { lockDocumentScroll } from "../src/lib/modalScrollLock";

function createDocumentWithScrollPolicy(
  overflow = "",
  overscrollBehavior = "",
): Document {
  return {
    body: {
      style: { overflow, overscrollBehavior } as CSSStyleDeclaration,
    },
  } as Document;
}

describe("lockDocumentScroll", () => {
  it("locks overflow and viewport overscroll until restoration", () => {
    const targetDocument = createDocumentWithScrollPolicy();
    const restore = lockDocumentScroll(targetDocument);

    expect(targetDocument.body.style.overflow).toBe("hidden");
    expect(targetDocument.body.style.overscrollBehavior).toBe("none");

    restore();
    expect(targetDocument.body.style.overflow).toBe("");
    expect(targetDocument.body.style.overscrollBehavior).toBe("");
  });

  it("restores the exact pre-existing inline scroll policy", () => {
    const targetDocument = createDocumentWithScrollPolicy("clip", "contain");
    const restore = lockDocumentScroll(targetDocument);
    restore();

    expect(targetDocument.body.style.overflow).toBe("clip");
    expect(targetDocument.body.style.overscrollBehavior).toBe("contain");
  });
});
