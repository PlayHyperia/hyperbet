export function lockDocumentScroll(targetDocument: Document): () => void {
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
