// Read layout only: fitting is safe when the canvas is the page's sole surface.
const surfaceTags = new Set(["IMG", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "SVG",
  "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const ignoredTags = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

function hasPublisherWindowSize(manifest) {
  return [manifest?.window?.width, manifest?.window?.height].some(value =>
    (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) && Number(value) > 0);
}

function initialCanvasFit(document, manifest, minSize = 200) {
  if (!document || hasPublisherWindowSize(manifest)) return null;
  const view = document.defaultView;
  const layoutVisibility = new Map();
  const styleFor = element => view?.getComputedStyle?.(element) || element.style || {};
  const displayed = element => {
    if (!element) return true;
    if (layoutVisibility.has(element)) return layoutVisibility.get(element);
    const style = styleFor(element);
    const result = style.display !== "none" && style.contentVisibility !== "hidden" &&
      !(style.opacity !== "" && style.opacity != null && Number(style.opacity) === 0) && displayed(element.parentElement);
    layoutVisibility.set(element, result);
    return result;
  };
  const visible = element => displayed(element) && !["hidden", "collapse"].includes(styleFor(element).visibility);
  const rectsFor = element => {
    if (!visible(element) || typeof element.getClientRects !== "function") return [];
    return Array.from(element.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  };
  const canvases = Array.from(document.querySelectorAll("canvas")).filter(canvas => rectsFor(canvas).length);
  if (canvases.length !== 1) return null;
  const canvas = canvases[0], bounds = canvas.getBoundingClientRect();
  const width = Math.round(bounds.width), height = Math.round(bounds.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < minSize || height < minSize) return null;
  const outside = rect => rect.width > 0 && rect.height > 0 &&
    (rect.left < bounds.left - 2 || rect.top < bounds.top - 2 || rect.right > bounds.right + 2 || rect.bottom > bounds.bottom + 2);

  for (const element of document.querySelectorAll("*")) {
    if (element === canvas || canvas.contains(element) || ignoredTags.has(element.tagName) || !visible(element)) continue;
    const style = styleFor(element);
    const isSurface = surfaceTags.has(element.tagName) || element.tabIndex >= 0 || element.isContentEditable ||
      (style.backgroundImage && style.backgroundImage !== "none");
    if (isSurface && rectsFor(element).some(outside)) return null;
    // Measure text, not its wrapper: a full-width container may contain only an
    // overlay inside the canvas. Ancestor textContent would count it repeatedly.
    for (const node of element.childNodes || []) {
      if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
      const range = document.createRange();
      try {
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(outside)) return null;
      } finally {
        range.detach?.();
      }
    }
  }
  return { canvas, width, height };
}

module.exports = { hasPublisherWindowSize, initialCanvasFit };
