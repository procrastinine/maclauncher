const VERSION = "1.0.0-ml1", PROFILE = "2.6.1.76";
const LIMITS = Object.freeze({ dimension: 8192, pixels: 16 * 1024 * 1024, layers: 4096, workPixels: 64 * 1024 * 1024 });
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;

// MASK selects a source byte in Windows BGRA order. The 2.6.1.76 MASK4
// path changes only destination alpha, using the engine's 8-bit product.
function maskedAlpha(destination, source) { return (((destination + 1) * (source + 1) - 1) & 0xffff) >>> 8; }

function validatePlane({ engineVersion, width, height, layers } = {}) {
  if (engineVersion !== PROFILE || !integer(width, 1, LIMITS.dimension) || !integer(height, 1, LIMITS.dimension) || width * height > LIMITS.pixels ||
      !Array.isArray(layers) || layers.length > LIMITS.layers) throw new Error("This bounded CatSystem2 plane profile is unsupported.");
  let work = 0;
  for (const layer of layers) {
    if (!layer || !integer(layer.width, 1, LIMITS.dimension) || !integer(layer.height, 1, LIMITS.dimension) || layer.width * layer.height > LIMITS.pixels ||
        !integer(layer.x, -LIMITS.dimension * 4, LIMITS.dimension * 4) || !integer(layer.y, -LIMITS.dimension * 4, LIMITS.dimension * 4) ||
        !integer(layer.alpha, 0, 255) || ![0, 4].includes(layer.mask) || layer.mask && layer.alpha !== 255 ||
        !Buffer.isBuffer(layer.rgba) || layer.rgba.length !== layer.width * layer.height * 4)
      throw new Error("This CatSystem2 plane layer or mask is unsupported.");
    work += Math.max(0, Math.min(width, layer.x + layer.width) - Math.max(0, layer.x)) *
      Math.max(0, Math.min(height, layer.y + layer.height) - Math.max(0, layer.y));
    if (work > LIMITS.workPixels) throw new Error("CatSystem2 plane compositing exceeds its pixel limit.");
  }
}

/** Composite into a new private surface; never mutate decoded original pixels. */
function composePlane(request, { signal } = {}) {
  signal?.throwIfAborted(); validatePlane(request);
  const { width, height, layers } = request, rgba = Buffer.alloc(width * height * 4);
  for (const layer of layers) {
    const left = Math.max(0, layer.x), right = Math.min(width, layer.x + layer.width), top = Math.max(0, layer.y), bottom = Math.min(height, layer.y + layer.height);
    for (let y = top; y < bottom; y++) {
      signal?.throwIfAborted();
      for (let x = left; x < right; x++) {
        const to = (y * width + x) * 4, from = ((y - layer.y) * layer.width + x - layer.x) * 4;
        if (layer.mask === 4) { rgba[to + 3] = maskedAlpha(rgba[to + 3], layer.rgba[from + 3]); continue; }
        const sourceAlpha = layer.rgba[from + 3] * layer.alpha, destinationAlpha = rgba[to + 3], inverse = 65025 - sourceAlpha;
        if (!sourceAlpha) continue;
        const outputAlpha = sourceAlpha * 255 + destinationAlpha * inverse;
        for (let channel = 0; channel < 3; channel++)
          rgba[to + channel] = Math.round((layer.rgba[from + channel] * sourceAlpha * 255 + rgba[to + channel] * destinationAlpha * inverse) / outputAlpha);
        rgba[to + 3] = Math.round(outputAlpha / 65025);
      }
    }
  }
  signal?.throwIfAborted();
  return Object.freeze({ rgba, width, height, canvasWidth: width, canvasHeight: height, offsetX: 0, offsetY: 0, frameId: 0, format: "FES-PLANE", generatorVersion: VERSION });
}
module.exports = { VERSION, PROFILE, LIMITS, maskedAlpha, validatePlane, composePlane };
