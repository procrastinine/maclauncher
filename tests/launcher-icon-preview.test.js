const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
const iconFunction = source.slice(source.indexOf("const sameIconFile = "), source.indexOf("\nfunction normalizeGameEntry("));

test("launcher previews bound image size, preserve aspect ratio and retain smaller originals", () => {
  for (const [width, height, expected] of [[1024, 1024, [128, 128]], [1024, 512, [128, 64]],
    [256, 1024, [32, 128]], [64, 48, [64, 48]], [2048, 1, [128, 1]]]) {
    let loads = 0, resizes = 0, encoded;
    const image = (w, h) => ({ isEmpty: () => false, getSize: () => ({ width: w, height: h }),
      resize(options) { resizes += 1; assert.equal(options.quality, "best"); return image(options.width, options.height); },
      toDataURL() { encoded = [w, h]; return `data:image/png;base64,${w}x${h}`; } });
    const context = { fs: { statSync: () => ({ isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }) },
      nativeImage: { createFromPath: () => { loads += 1; return image(width, height); } }, iconDataUrlCache: new Map(), gameRecordsCache: null, performance };
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
  const context = { iconDataUrlCache: cache, gameRecordsCache: null, performance,
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

test("a large library keeps every game's icon preview between state rebuilds", () => {
  const cache = new Map(); let loads = 0;
  const context = { iconDataUrlCache: cache, gameRecordsCache: Array.from({ length: 600 }, (_, index) => ({ gameId: `game-${index}` })), performance,
    fs: { statSync: () => ({ isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }) },
    nativeImage: { createFromPath: file => { loads += 1; return { isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), toDataURL: () => file }; } } };
  vm.createContext(context); vm.runInContext(iconFunction, context);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 600; i++) context.iconUrlForPath("/icon/" + i);
  assert.equal(loads, 600, "A second rebuild reuses every preview");
  assert.equal(cache.size, 600);
});

test("library rows never wait for icon decoding: pending icons decode in short slices and one rebuild follows", () => {
  const immediates = [], decoded = [];
  let clock = 0, rebuilds = 0;
  const context = { iconDataUrlCache: new Map(), gameRecordsCache: null, setImmediate: run => immediates.push(run),
    performance: { now: () => (clock += 5) }, scheduleStateRebuild: () => { rebuilds += 1; },
    fs: { statSync: () => ({ isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }) },
    nativeImage: { createFromPath: file => { decoded.push(file); return { isEmpty: () => file.endsWith(".txt"),
      getSize: () => ({ width: 64, height: 64 }), toDataURL: () => "data:" + file }; } } };
  vm.createContext(context); vm.runInContext(iconFunction, context);
  const files = ["/a.png", "/b.png", "/c.png", "/d.png", "/broken.txt"];
  assert.deepEqual(files.map(file => context.libraryIcon(file)?.pending), files.map(() => true));
  assert.equal(context.libraryIcon("/a.png").pending, true, "a pending icon is queued once");
  assert.deepEqual(decoded, [], "the state that asked decodes nothing");
  let slices = 0;
  while (immediates.length) { immediates.shift()(); slices += 1; }
  assert.ok(slices >= 2, "decoding yields between slices");
  assert.deepEqual(decoded.sort(), files.slice().sort());
  assert.equal(rebuilds, 1, "one state rebuild carries every decoded icon");
  assert.equal(vm.runInContext("iconGeneration", context), 1);
  assert.equal(context.libraryIcon("/a.png").url, "data:/a.png");
  assert.equal(context.libraryIcon("/broken.txt"), null, "a file that is not a readable image falls back");
  assert.equal(context.canRenderIconPath("/broken.txt"), false);
  assert.equal(decoded.length, files.length, "neither result is decoded again");
});
