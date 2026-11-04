const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Screenshots = require("../src/modules/shared/reshade/screenshots");
const CaptureFile = require("../src/modules/shared/reshade/capture-file"), zlib = require("node:zlib");

function rawFrame(width, height, flags, bytes, version = 1) {
  const header = Buffer.alloc(24);header.write(version === 2 ? "MCLCAP02" : "MCLCAP01");
  [width, height, width * (version === 2 ? 8 : 4), flags].forEach((value, index) => header.writeUInt32LE(value, 8 + index * 4));
  return Buffer.concat([header, Buffer.from(bytes)]);
}
function pngPixels(file) {
  const png = fs.readFileSync(file);assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const data = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    assert.equal(png.readUInt32BE(offset + 8 + length), zlib.crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0);
    if (type === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return zlib.inflateSync(Buffer.concat(data));
}

test("raw processed captures become opaque PNGs in the launcher, preserving channel order and origin", async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-raw-screenshot-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  for (const flags of [0, 1, 2, 3]) {
    const prefix = path.join(work, "frame" + flags), bytes = [1,2,3,4,5,6,7,8];
    fs.writeFileSync(prefix + "-after.rgba", rawFrame(1, 2, flags, bytes));
    assert.equal(await Screenshots.wait(prefix, Date.now(), {timeout: 1000}), prefix + "-after.png");
    const rows = flags & 2 ? [[5,6,7], [1,2,3]] : [[1,2,3], [5,6,7]];
    const expected = rows.flatMap(row => [0, ...(flags & 1 ? row.reverse() : row), 255]);
    assert.deepEqual([...pngPixels(prefix + "-after.png")], expected);
    assert.equal(fs.existsSync(prefix + "-after.rgba"), false);
    const saved = Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: path.join(work, "Pictures")}});
    assert.deepEqual([...pngPixels(saved)], expected);assert.deepEqual(Screenshots.staged(prefix), []);
  }
});

test("HDR captures retain 16-bit PQ samples, BT.2020 metadata and the captured row origin", t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hdr-screenshot-"));
  t.after(() => fs.rmSync(work, {recursive:true,force:true}));
  const pixels = [[1024,32768,60000,1234],[4096,50000,65535,4321]], bytes = Buffer.alloc(16);
  pixels.flat().forEach((value,index)=>bytes.writeUInt16LE(value,index*2));
  for (const flags of [4,6]) {
    const prefix=path.join(work,'hdr'+flags), file=prefix+'-after.rgba';
    fs.writeFileSync(file,rawFrame(1,2,flags,bytes,2));
    const frame=CaptureFile.read(file);
    assert.equal(frame.bitDepth,16);assert.equal(frame.colorSpace,'rec2100-pq');
    const saved=Screenshots.save({prefix,title:'HDR',settings:{graphicsScreenshotFolder:path.join(work,'Pictures')}});
    const png=fs.readFileSync(saved), chunks=new Map();
    for(let offset=8;offset<png.length;){
      const length=png.readUInt32BE(offset);
      chunks.set(png.toString('ascii',offset+4,offset+8),png.subarray(offset+8,offset+8+length));
      offset+=length+12;
    }
    assert.equal(chunks.get('IHDR')[8],16);assert.equal(chunks.get('IHDR')[9],2);
    assert.deepEqual([...chunks.get('cICP')],[9,16,0,1]);assert.equal(chunks.has('sRGB'),false);
    const rows=flags&2?[pixels[1],pixels[0]]:pixels, expected=Buffer.alloc(14);
    rows.forEach((pixel,y)=>pixel.slice(0,3).forEach((value,channel)=>expected.writeUInt16BE(value,y*7+1+channel*2)));
    assert.deepEqual(pngPixels(saved),expected);
    assert.deepEqual(Screenshots.staged(prefix),[]);
  }
  fs.writeFileSync(path.join(work,'wrong-format'),rawFrame(1,2,4,bytes));
  assert.throws(()=>CaptureFile.read(path.join(work,'wrong-format')),/layout/);
});

test("raw capture parsing rejects invalid, oversized, truncated and linked inputs and clears failed staging", t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-invalid-capture-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const prefix = path.join(work, "frame"), file = prefix + "-after.rgba", valid = rawFrame(1, 1, 0, [1,2,3,4]);
  const invalid = [valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), rawFrame(0,1,0,[]), rawFrame(32769,1,0,[]), rawFrame(1,1,4,[1,2,3,4])];
  const wrongMagic = Buffer.from(valid);wrongMagic[0] = 0;invalid.push(wrongMagic);
  for (const bytes of invalid) {fs.writeFileSync(file, bytes);assert.throws(() => CaptureFile.read(file));}
  fs.writeFileSync(file, valid);fs.symlinkSync(file, path.join(work, "link"));assert.throws(() => CaptureFile.read(path.join(work, "link")));
  fs.writeFileSync(file, invalid[0]);fs.writeFileSync(prefix + ".capture-7-after.rgba", "partial");
  assert.throws(() => Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: path.join(work, "Pictures")}}));
  assert.deepEqual(Screenshots.staged(prefix), []);
  assert.throws(() => CaptureFile.png({width: 1, height: 1, stride: 4, flags: 2 ** 32, buffer: Buffer.alloc(4)}));
});

test("screenshot names use the game title and local time, and never overwrite", () => {
  const date = new Date(2026, 9, 31, 14, 5, 9);
  assert.equal(Screenshots.fileName("Celeste", date), "Celeste 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.fileName("A/B: C\\D\n", date), "A B C D 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.fileName("...", date), "Screenshot 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.baseName("x".repeat(300), date).length, 96 + " 2026-10-31 at 14.05.09".length);
  const taken = new Set(["Celeste 2026-10-31 at 14.05.09.png", "Celeste 2026-10-31 at 14.05.09 2.png"]);
  assert.equal(Screenshots.fileName("Celeste", date, name => taken.has(name)), "Celeste 2026-10-31 at 14.05.09 3.png");
});

test("saving moves the processed image out and leaves nothing staged", t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshots-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const launch = path.join(work, "launch"), pictures = path.join(work, "Pictures");fs.mkdirSync(launch);
  const prefix = path.join(launch, "frame-capture");
  for (let index = 0; index < 3; index++) {
    fs.writeFileSync(prefix + "-before.png", "before");fs.writeFileSync(prefix + "-after.png", "after " + index);
    fs.writeFileSync(prefix + ".capture-7-after.png", "partial");
    const saved = Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: pictures}, date: new Date(2026, 0, 2, 3, 4, 5)});
    assert.equal(fs.readFileSync(saved, "utf8"), "after " + index);
    assert.deepEqual(Screenshots.staged(prefix), []);
  }
  assert.deepEqual(fs.readdirSync(launch), []);
  assert.deepEqual(fs.readdirSync(pictures).sort(), ["Game 2026-01-02 at 03.04.05 2.png", "Game 2026-01-02 at 03.04.05 3.png", "Game 2026-01-02 at 03.04.05.png"]);
  // A failed capture also clears what it staged.
  fs.writeFileSync(prefix + "-before.png", "before");
  assert.throws(() => Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: pictures}}));
  assert.deepEqual(fs.readdirSync(launch), []);
});

test("the default folder is visible and a chosen folder must be absolute", () => {
  assert.equal(Screenshots.folder({}), path.join(os.homedir(), "Pictures", "MacLauncher"));
  assert.equal(Screenshots.folder({graphicsScreenshotFolder: "relative"}), Screenshots.DEFAULT_FOLDER);
  assert.equal(Screenshots.folder({graphicsScreenshotFolder: "/Volumes/Shots"}), "/Volumes/Shots");
});

const {spawnSync} = require("node:child_process");
const compiler = process.platform === "darwin" ? spawnSync("xcrun", ["--find", "clang++"], {encoding: "utf8"}) : null;
test("native raw capture serialization omits row padding and never invokes an image codec", {skip: !compiler || compiler.status !== 0 ? "clang++ is unavailable" : false}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-capture-file-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const binary = path.join(work, "capture-file"), file = path.join(work, "frame.rgba");
  const build = spawnSync("xcrun", ["clang++", "-std=c++20", "-Wall", "-Werror", path.join(__dirname, "native/capture-file.cpp"), "-o", binary], {encoding: "utf8"});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [file], {encoding: "utf8"});assert.equal(run.status, 0, run.stderr);
  const frame = CaptureFile.read(file);assert.equal(frame.stride, 8);assert.equal(frame.flags, 3);
  assert.deepEqual([...frame.buffer], [3,2,1,4,7,6,5,8,11,10,9,12,15,14,13,16]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const native = fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native/metal.mm"), "utf8");
  assert.doesNotMatch(native, /savePNG|representationUsingType:NSBitmapImageFileTypePNG/);
  const capture = fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native/frame-capture.hpp"), "utf8");
  assert.match(capture, /dispatch_async\(captureWriterQueue\(\)/);
});
test("float, 10-bit, PQ and HLG outputs are converted to 8-bit sRGB for capture", {skip: !compiler || compiler.status !== 0 ? "clang++ is unavailable" : false}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshot-color-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const source = path.join(__dirname, "../src/modules/shared/reshade/native/test/screenshot-color.mm"), binary = path.join(work, "screenshot-color");
  const build = spawnSync("xcrun", ["clang++", "-x", "objective-c++", "-std=c++20", "-fobjc-arc", "-Wall", "-Werror", source, "-o", binary,
    "-framework", "Foundation", "-framework", "Metal", "-framework", "CoreGraphics"], {encoding: "utf8"});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], {encoding: "utf8"});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /screenshot-color: pass/);
});

test("a sandbox that moves the capture channel rewrites the launch record, and saving reads the moved paths", async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshot-sandbox-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const launchDirectory = path.join(work, "launch"), writable = path.join(work, "writable"), pictures = path.join(work, "Pictures");
  fs.mkdirSync(launchDirectory);fs.mkdirSync(writable);
  const original = {prefix: path.join(launchDirectory, "frame-capture"), trigger: path.join(launchDirectory, "frame-capture.request")};
  fs.writeFileSync(path.join(launchDirectory, "launch.json"), JSON.stringify({schema: 1, launchId: "a", phase: "prepared", screenshotCapture: original}));
  fs.writeFileSync(path.join(writable, "frame-capture.capture-3-after.png"), "stale");
  const {isolateGraphics} = require("../src/modules/shared/runtime/macos-sandbox");
  const scoped = await isolateGraphics({RESHADE_CAPTURE_PREFIX: original.prefix, RESHADE_CAPTURE_TRIGGER: original.trigger, RESHADE_CAPTURE_FINAL: "1"}, launchDirectory, writable);
  const moved = {prefix: path.join(writable, "frame-capture"), trigger: path.join(writable, "frame-capture.request")};
  assert.equal(scoped.graphics.RESHADE_CAPTURE_PREFIX, moved.prefix);
  assert.equal(scoped.graphics.RESHADE_CAPTURE_TRIGGER, moved.trigger);
  const launch = JSON.parse(fs.readFileSync(path.join(launchDirectory, "launch.json"), "utf8"));
  assert.deepEqual(launch.screenshotCapture, moved);
  assert.equal(launch.launchId, "a");
  assert.deepEqual(Screenshots.staged(moved.prefix), []);
  // The launcher requests and saves through the paths the record reports.
  const requestedAt = Date.now();Screenshots.request(launch.screenshotCapture.trigger);
  assert.ok(fs.existsSync(moved.trigger));
  fs.writeFileSync(moved.prefix + "-after.png", "processed");
  assert.equal(await Screenshots.wait(launch.screenshotCapture.prefix, requestedAt, {timeout: 1000}), moved.prefix + "-after.png");
  const saved = Screenshots.save({prefix: launch.screenshotCapture.prefix, title: "Sandboxed", settings: {graphicsScreenshotFolder: pictures}});
  assert.equal(fs.readFileSync(saved, "utf8"), "processed");
  assert.deepEqual(Screenshots.staged(moved.prefix), []);
  // Diagnostic capture has no screenshot channel, so its record is left alone.
  fs.writeFileSync(path.join(launchDirectory, "launch.json"), JSON.stringify({schema: 1, launchId: "b"}));
  assert.equal(Screenshots.relocate(original.prefix, moved), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(launchDirectory, "launch.json"), "utf8")).screenshotCapture, undefined);
});


test("G9: game and window screenshot channels require an assigned Screenshot shortcut", {skip: process.platform !== "darwin"}, async t => {
  const ReShade = require("../src/modules/shared/reshade"), Native = require("../src/modules/shared/runtime/bundled-native");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-opt-in-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runtime = path.join(root, "runtime"), userDataDir = path.join(root, "profile");fs.mkdirSync(path.join(runtime, "effects"), {recursive: true});
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/crt.fx"]) fs.writeFileSync(path.join(runtime, file), "fixture");
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({schema: 1, version: "test", minimumMacOS: "11.0", features: {graphics: {effectPlanAPI: 1, screenshotAPI: 1}}}));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const options = {root: runtime, userDataDir, diagnostics: false, capture: false, gpuTiming: false, trace: false, verify: () => true, execute: () => assert.fail("no shader")};
  const effects = {schema: 2, mode: "advanced", video: [{id: "spatial", kind: "spatial", enabled: true, method: "bilinear", settings: {}}]};
  let index = 0;
  for (const explicitHost of [false, true]) for (const assigned of [false, true]) {
    const environment = await ReShade.prepare({gameId: "shot" + ++index, effects}, {...options, graphicsHost: "window", explicitHost,
      settings: {launcher: {graphicsShortcuts: assigned ? {screenshot: "Command+Shift+S"} : {}}}});
    const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_CONTROL_FILE), "launch.json"), "utf8"));
    assert.equal(Boolean(launch.screenshotCapture), assigned);
    for (const key of ["RESHADE_CAPTURE_PREFIX", "RESHADE_CAPTURE_TRIGGER", "RESHADE_CAPTURE_FINAL"]) assert.equal(Object.hasOwn(environment, key), assigned, key);
  }
});
