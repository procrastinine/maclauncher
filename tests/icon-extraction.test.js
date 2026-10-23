const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { extractIcon, runIconCommand } = require("../src/core/icon-extraction");
const { encodePngBitmap } = require("../src/core/icon-utils");

test("icon conversion bounds the helper and cleans temporary output after success and failure", { skip: process.platform !== "darwin" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maclauncher-icon-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Game.app"), resources = path.join(app, "Contents", "Resources");
  await fs.mkdir(resources, { recursive: true });
  const icon = path.join(resources, "icon.icns");
  await fs.writeFile(icon, "original");
  const png = encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([1, 2, 3, 255]) });
  for (const mode of ["success", "failure", "invalid", "oversized"]) {
    const result = await extractIcon(app, "app", { temporaryRoot: root,
      runCommand: async (command, args, options) => {
        assert.equal(command, "/usr/bin/sips");
        assert.equal(options.timeout, 10000); assert.equal(options.killSignal, "SIGKILL");
        assert.equal(options.maxBuffer, 65536);
        const output = args.at(-1);
        await fs.writeFile(output, mode === "invalid" ? "broken" : png);
        if (mode === "oversized") await fs.truncate(output, 16 * 1024 * 1024 + 1);
        if (mode === "failure") throw new Error("helper failed");
      } });
    assert.deepEqual(result, mode === "success" ? { png } : { fallbackPath: icon });
    assert.deepEqual(await fs.readdir(root), ["Game.app"]);
    assert.equal(await fs.readFile(icon, "utf8"), "original");
  }
});

test("cancelling icon conversion stops its child and removes temporary output", { skip: process.platform !== "darwin" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maclauncher-icon-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Game.app"), resources = path.join(app, "Contents", "Resources");
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, "icon.icns"), "original");
  const controller = new AbortController();
  const ready = path.join(resources, "child.pid");
  let childPid;
  const pending = extractIcon(app, "app", { temporaryRoot: root, signal: controller.signal,
    runCommand: async (_command, args, options) => {
      const request = runIconCommand(process.execPath, ["-e",
        "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ready], options);
      const deadline = Date.now() + 5000;
      while (childPid === undefined) {
        try { childPid = Number(await fs.readFile(ready, "utf8")); }
        catch { if (Date.now() > deadline) { controller.abort(); await request.catch(() => {}); throw Error("Conversion child did not start"); } }
        if (childPid === undefined) await new Promise(resolve => setTimeout(resolve, 5));
      }
      await fs.writeFile(args.at(-1), "partial");
      controller.abort();
      return request;
    } });
  await assert.rejects(pending, { name: "AbortError" });
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "A conversion child ignoring SIGTERM still exits on cancellation");
  assert.deepEqual(await fs.readdir(root), ["Game.app"]);
});
