const { finished } = require("node:stream/promises");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

let electron;
try { electron = require("electron"); } catch {}
const available = typeof electron === "string" && fs.existsSync(electron);

// The main process's icon functions run in an actual Electron main process,
// with Electron's ASAR-aware fs and nativeImage, against a module icon packed
// in an app.asar as a packaged app ships it.
test("a module icon inside app.asar decodes to a preview and its library row stops pending", { skip: !available, timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-icon-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = "src/modules/demo/resources/icon.png", source = path.join(root, "source");
  fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../src/modules/anyps5/resources/icon.png"), path.join(source, relative));
  const archive = path.join(root, "app.asar");
  await finished(await require("@electron/asar").createPackageWithOptions(source, archive, {}));
  assert.equal(fs.existsSync(archive + ".unpacked"), false, "the icon is packed inside the archive");
  const runner = path.join(root, "check.cjs");
  fs.writeFileSync(runner, `
const { app, nativeImage } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const options = JSON.parse(process.argv[process.argv.length - 1]);
app.dock?.hide();
app.whenReady().then(async () => {
  try {
    const source = fs.readFileSync(options.main, "utf8");
    const slice = source.slice(source.indexOf("const sameIconFile = "), source.indexOf("\\nfunction normalizeGameEntry("));
    let rebuilds = 0, rebuilt;
    const context = { fs, nativeImage, performance, setImmediate, iconDataUrlCache: new Map(), gameRecordsCache: null,
      scheduleStateRebuild: () => { rebuilds += 1; rebuilt?.(); } };
    vm.createContext(context); vm.runInContext(slice, context);
    assert.notEqual(fs.statSync(options.icon).ino, fs.statSync(options.icon).ino, "Electron reports a new inode on every stat inside the archive");
    assert.deepEqual({ ...context.libraryIcon(options.icon) }, { pending: true });
    await new Promise(resolve => { rebuilt = resolve; });
    const first = context.libraryIcon(options.icon);
    assert.match(first?.url || "", /^data:image\\/png;base64,/);
    assert.deepEqual(nativeImage.createFromDataURL(first.url).getSize(), { width: 128, height: 128 });
    const reads = vm.runInContext("iconPendingReads", context);
    for (let rebuild = 0; rebuild < 3; rebuild++) assert.equal(context.libraryIcon(options.icon).url, first.url);
    assert.equal(vm.runInContext("iconPendingReads", context), reads, "the decoded preview is reused, not queued again");
    assert.equal(context.iconUrlForPath(options.icon), first.url);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rebuilds, 1, "one state rebuild carries the decoded icon");
    console.log(JSON.stringify({ passed: true }));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = { main: path.join(__dirname, "../src/main/main.js"), icon: path.join(archive, relative) };
  const result = spawnSync(electron, [runner, JSON.stringify(options)], { env, encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").pop()).passed, true);
});
