const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
const iconFunction = source.slice(source.indexOf("function iconUrlForPath("), source.indexOf("\nfunction canRenderIconPath("));

test("launcher previews bound image size, preserve aspect ratio and retain smaller originals", () => {
  for (const [width, height, expected] of [[1024, 1024, [128, 128]], [1024, 512, [128, 64]],
    [256, 1024, [32, 128]], [64, 48, [64, 48]], [2048, 1, [128, 1]]]) {
    let loads = 0, resizes = 0, encoded;
    const image = (w, h) => ({ isEmpty: () => false, getSize: () => ({ width: w, height: h }),
      resize(options) { resizes += 1; assert.equal(options.quality, "best"); return image(options.width, options.height); },
      toDataURL() { encoded = [w, h]; return `data:image/png;base64,${w}x${h}`; } });
    const context = { fs: { statSync: () => ({ isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }) },
      nativeImage: { createFromPath: () => { loads += 1; return image(width, height); } }, iconDataUrlCache: new Map() };
    vm.createContext(context); vm.runInContext(iconFunction, context);
    const first = context.iconUrlForPath("/original/icon.png");
    assert.deepEqual(encoded, expected);
    assert.equal(resizes, Math.max(width, height) > 128 ? 1 : 0);
    assert.equal(context.iconUrlForPath("/original/icon.png"), first);
    assert.equal(loads, 1, "The preview remains cached against original file identity");
  }
});

test("launcher icon previews release old paths and keep recently used entries", () => {
  const cache = new Map(); let missing = false;
  const context = { iconDataUrlCache: cache,
    fs: { statSync: () => { if (missing) throw Error("missing"); return { isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }; } },
    nativeImage: { createFromPath: file => ({ isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), toDataURL: () => file }) } };
  vm.createContext(context); vm.runInContext(iconFunction, context);
  for (let i = 0; i < 256; i++) context.iconUrlForPath("/icon/" + i);
  context.iconUrlForPath("/icon/0"); context.iconUrlForPath("/icon/256");
  assert.equal(cache.size, 256); assert.ok(cache.has("/icon/0")); assert.equal(cache.has("/icon/1"), false);
  for (let i = 257; i < 1000; i++) context.iconUrlForPath("/icon/" + i);
  assert.equal(cache.size, 256);
  missing = true; assert.equal(context.iconUrlForPath("/icon/999"), null); assert.equal(cache.has("/icon/999"), false);
});
