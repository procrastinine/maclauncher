const LIMITS = Object.freeze({ dimension: 16384, pixels: 32 * 1024 * 1024, bytes: 128 * 1024 * 1024, tiles: 8192 });

/** Sparse original-sized atlas. Transparent clears allocate no duplicate image bytes. */
function createBitmap({ width, height, tileWidth, tileHeight, bpp } = {}) {
  if (![width, height, tileWidth, tileHeight].every(value => Number.isInteger(value) && value > 0 && value <= LIMITS.dimension) ||
      width * height > LIMITS.pixels || bpp !== 32 || Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight) > LIMITS.tiles)
    throw new Error("This CatSystem2 bitmap layout is unsupported.");
  const tiles = new Map(); let allocatedBytes = 0;
  function rectangle(x, y, w, h) {
    if (![x, y, w, h].every(Number.isSafeInteger) || Math.abs(x) > LIMITS.dimension || Math.abs(y) > LIMITS.dimension ||
        w < 0 || h < 0 || w > LIMITS.dimension || h > LIMITS.dimension) throw new Error("CatSystem2 bitmap rectangle exceeds its bounds.");
    return { left: Math.max(0, x), top: Math.max(0, y), right: Math.min(width, x + w), bottom: Math.min(height, y + h) };
  }
  function fill(x, y, w, h, color = 0) {
    const r = rectangle(x, y, w, h);
    if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new Error("CatSystem2 bitmap color exceeds its range.");
    if (r.right <= r.left || r.bottom <= r.top) return;
    const pixel = Buffer.from([color >>> 16 & 255, color >>> 8 & 255, color & 255, color >>> 24]);
    for (let row = Math.floor(r.top / tileHeight); row < Math.ceil(r.bottom / tileHeight); row++) {
      for (let col = Math.floor(r.left / tileWidth); col < Math.ceil(r.right / tileWidth); col++) {
        const key = row * Math.ceil(width / tileWidth) + col, tx = col * tileWidth, ty = row * tileHeight;
        const tw = Math.min(tileWidth, width - tx), th = Math.min(tileHeight, height - ty);
        const left = Math.max(r.left - tx, 0), right = Math.min(r.right - tx, tw), top = Math.max(r.top - ty, 0), bottom = Math.min(r.bottom - ty, th);
        let tile = tiles.get(key);
        if (!color && left === 0 && right === tw && top === 0 && bottom === th) {
          if (tile) { tiles.delete(key); allocatedBytes -= tile.length; } continue;
        }
        if (!tile) {
          if (!color) continue;
          const bytes = tw * th * 4; if (allocatedBytes + bytes > LIMITS.bytes) throw new Error("CatSystem2 bitmap storage exceeds its limit.");
          tile = Buffer.alloc(bytes); tiles.set(key, tile); allocatedBytes += bytes;
        }
        for (let at = top; at < bottom; at++) tile.fill(pixel, (at * tw + left) * 4, (at * tw + right) * 4);
      }
    }
  }
  function pixel(x, y) {
    if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= width || y >= height) throw new Error("CatSystem2 bitmap pixel exceeds its bounds.");
    const col = Math.floor(x / tileWidth), row = Math.floor(y / tileHeight), tile = tiles.get(row * Math.ceil(width / tileWidth) + col);
    if (!tile) return Buffer.alloc(4);
    const tw = Math.min(tileWidth, width - col * tileWidth), at = ((y % tileHeight) * tw + x % tileWidth) * 4;
    return Buffer.from(tile.subarray(at, at + 4));
  }
  return { width, height, fill, pixel, clear: () => { tiles.clear(); allocatedBytes = 0; }, get allocatedBytes() { return allocatedBytes; } };
}
module.exports = { LIMITS, createBitmap };
