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
  let clock = 0, rebuilds = 0, saves = 0;
  const context = { iconDataUrlCache: new Map(), gameRecordsCache: null, setImmediate: run => immediates.push(run),
    performance: { now: () => (clock += 5) }, scheduleStateRebuild: () => { rebuilds += 1; }, saveIconPreviewsSoon: () => { saves += 1; },
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
  assert.equal(saves, 1, "the round's previews are saved for the next launch once");
  assert.equal(vm.runInContext("iconGeneration", context), 1);
  assert.equal(context.libraryIcon("/a.png").url, "data:/a.png");
  assert.equal(context.libraryIcon("/broken.txt"), null, "a file that is not a readable image falls back");
  assert.equal(context.canRenderIconPath("/broken.txt"), false);
  assert.equal(decoded.length, files.length, "neither result is decoded again");
});

function sliceContext({ statSync, decode }) {
  const immediates = [], decoded = [];
  const context = { iconDataUrlCache: new Map(), gameRecordsCache: null, setImmediate: run => immediates.push(run), performance,
    scheduleStateRebuild: () => { context.rebuilds += 1; }, saveIconPreviewsSoon() {}, rebuilds: 0, fs: { statSync },
    nativeImage: { createFromPath: file => { decoded.push(file); return { isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), toDataURL: () => decode(file) }; } } };
  vm.createContext(context); vm.runInContext(iconFunction, context);
  const settle = () => { let rounds = 0; while (immediates.length) { immediates.shift()(); rounds += 1; } return rounds; };
  return { context, decoded, immediates, settle };
}

test("an archived icon whose inode changes on every stat decodes once and its row stops pending", () => {
  let ino = 0;
  const { context, decoded, immediates, settle } = sliceContext({ decode: file => "data:" + file,
    statSync: () => ({ isFile: () => true, mtimeMs: 7, ctimeMs: 7, ino: ++ino, size: 100 }) });
  const icon = "/App.app/Contents/Resources/app.asar/src/modules/demo/resources/icon.png";
  assert.equal(context.libraryIcon(icon).pending, true);
  settle();
  assert.equal(context.rebuilds, 1);
  for (let rebuild = 0; rebuild < 3; rebuild++) assert.deepEqual({ ...context.libraryIcon(icon) }, { url: "data:" + icon });
  assert.equal(immediates.length, 0, "a decoded archive icon queues no further decoding");
  assert.equal(context.iconUrlForPath(icon), "data:" + icon);
  assert.deepEqual(decoded, [icon]);
});

test("a file whose identity changes on every stat keeps its preview and decoding rounds end", () => {
  let mtimeMs = 0, content = "a";
  const { context, decoded, immediates, settle } = sliceContext({ decode: file => `data:${file}:${content}`,
    statSync: () => ({ isFile: () => true, mtimeMs: ++mtimeMs, ctimeMs: 1, ino: 1, size: 100 }) });
  assert.equal(context.libraryIcon("/unstable.png").pending, true);
  settle();
  assert.equal(context.rebuilds, 1);
  assert.equal(context.libraryIcon("/unstable.png").url, "data:/unstable.png:a", "the row shows the previous preview while it is checked again");
  assert.equal(context.libraryIcon("/unstable.png").url, "data:/unstable.png:a");
  settle();
  assert.equal(context.rebuilds, 1, "a round with unchanged results rebuilds nothing");
  assert.equal(immediates.length, 0);
  assert.equal(decoded.length, 2);
  content = "b";
  assert.equal(context.libraryIcon("/unstable.png").url, "data:/unstable.png:a");
  settle();
  assert.equal(context.rebuilds, 2, "a changed image rebuilds once");
  assert.equal(context.libraryIcon("/unstable.png").url, "data:/unstable.png:b");
});

test("a pending icon whose file disappears before decoding releases its row", () => {
  let missing = false;
  const { context, decoded, settle } = sliceContext({ decode: file => "data:" + file,
    statSync: () => { if (missing) throw Error("missing"); return { isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 100 }; } });
  assert.equal(context.libraryIcon("/gone.png").pending, true);
  missing = true;
  settle();
  assert.equal(context.rebuilds, 1);
  assert.equal(context.libraryIcon("/gone.png"), null);
  assert.deepEqual(decoded, []);
});

test("decoded previews persist across launches, so unchanged icons are in the first library paint", async t => {
  const os = require("node:os");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-previews-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const persistence = source.slice(source.indexOf("const ICON_PREVIEW_FORMAT = "), source.indexOf("// Size and timestamps identify"));
  const stat = { isFile: () => true, mtimeMs: 3, ctimeMs: 3, ino: 1, size: 100 };
  const launch = version => {
    const timers = [], decoded = [];
    const context = { fs: { ...fs, statSync: () => stat }, path, userDataDir, app: { getVersion: () => version }, Number, Array, JSON, Map, Promise,
      logger: { debug() {} }, setTimeout: run => (timers.push(run), { unref() {} }), clearTimeout() {}, gameRecordsCache: null, performance,
      setImmediate: run => run(), scheduleStateRebuild() {},
      nativeImage: { createFromPath: file => { decoded.push(file); return { isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), toDataURL: () => "data:image/png;base64," + file }; } } };
    vm.createContext(context); vm.runInContext(persistence + iconFunction, context);
    return { context, timers, decoded, write: () => vm.runInContext("iconPreviewWrite", context) };
  };
  const first = launch("1.0.0");
  assert.equal(first.context.libraryIcon("/icon.png").pending, true);
  assert.equal(first.timers.length, 1, "the decoding round schedules one save");
  first.timers.shift()(); await first.write();
  const second = launch("1.0.0");
  assert.deepEqual({ ...second.context.libraryIcon("/icon.png") }, { url: "data:image/png;base64,/icon.png" }, "the next launch shows the preview at once");
  assert.deepEqual(second.decoded, [], "an unchanged file is not decoded again");
  stat.mtimeMs = 4;
  assert.equal(second.context.libraryIcon("/icon.png").url, "data:image/png;base64,/icon.png", "a changed file shows its previous preview while it decodes");
  assert.deepEqual(second.decoded, ["/icon.png"]);
  assert.equal(launch("2.0.0").context.libraryIcon("/icon.png").pending, true, "another app version decodes again");
  fs.writeFileSync(path.join(userDataDir, "icon-previews.json"), JSON.stringify({ format: 1, version: "1.0.0",
    previews: [["/script.png", { mtimeMs: 4, ctimeMs: 3, size: 100, url: "javascript:alert(1)" }]] }));
  assert.equal(launch("1.0.0").context.libraryIcon("/script.png").pending, true, "only image data URLs are taken from the file");
});
