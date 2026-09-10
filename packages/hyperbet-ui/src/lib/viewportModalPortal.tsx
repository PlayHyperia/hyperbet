import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ViewportModalPortalProps {
  children: ReactNode;
}

export function resolveViewportModalHost(
  targetDocument: Document | undefined,
): HTMLElement | null {
  return targetDocument?.body ?? null;
}

/**
 * Mounts fixed-position transaction UI at the document boundary.
 *
 * Mobile betting controls live inside a transformed bottom sheet. A fixed
 * descendant of that sheet is fixed to the sheet rather than the viewport,
 * which can clip confirmation actions below the sheet's scroll boundary.
 */
export function ViewportModalPortal({
  children,
}: ViewportModalPortalProps): ReactNode {
  const host = resolveViewportModalHost(
    typeof document === "undefined" ? undefined : document,
  );
  return host ? createPortal(children, host) : null;
}
