export type ModalScrollLockDocument = Pick<Document, "body">;

/**
 * Prevent the page behind a viewport modal from moving while preserving the
 * exact pre-existing inline policy for nested dialogs and teardown.
 */
export function lockModalDocumentScroll(
  targetDocument: ModalScrollLockDocument,
): () => void {
  const { style } = targetDocument.body;
  const previousOverflow = style.overflow;
  const previousOverscrollBehavior = style.overscrollBehavior;
  style.overflow = "hidden";
  style.overscrollBehavior = "none";

  return () => {
    style.overflow = previousOverflow;
    style.overscrollBehavior = previousOverscrollBehavior;
  };
}
