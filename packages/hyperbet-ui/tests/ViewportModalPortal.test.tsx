import "./setup";
import { describe, expect, it } from "bun:test";

import { resolveViewportModalHost } from "../src/lib/viewportModalPortal";

describe("ViewportModalPortal", () => {
  it("selects the document body instead of a transformed component parent", () => {
    const transformedParent = document.createElement("div");
    transformedParent.style.transform = "translateY(0)";
    document.body.appendChild(transformedParent);

    expect(resolveViewportModalHost(document)).toBe(document.body);
    expect(resolveViewportModalHost(document)).not.toBe(transformedParent);
  });

  it("fails closed when no browser document exists", () => {
    expect(resolveViewportModalHost(undefined)).toBeNull();
  });
});
