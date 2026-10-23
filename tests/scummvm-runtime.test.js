const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/scummvm/runtime/catalog");
const { createManager } = require("../src/modules/scummvm/runtime/manager");
const { extractDmg } = require("../src/modules/scummvm/runtime/dmg");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scummvm-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
test("ScummVM parses stable universal-era versions and validates publisher checksums", () => {
  assert.deepEqual(Catalog.parseVersions('<a href="2.9.1/">x</a><a href="2026.4.0/">x</a><a href="2.4.0/">x</a><a href="2.9.1/">x</a><a href="2.9.0rc1/">x</a>'), ["2026.4.0", "2.9.1"]);
  assert.equal(Catalog.parseDigest("a".repeat(64), "runtime.dmg"), "a".repeat(64));
  assert.equal(Catalog.parseDigest("b".repeat(64) + " *runtime.dmg\n", "runtime.dmg"), "b".repeat(64));
  assert.throws(() => Catalog.parseDigest("b".repeat(64) + " *wrong.dmg", "runtime.dmg"), /invalid/);
  assert.throws(() => Catalog.parseDigest("not a checksum", "runtime.dmg"), /invalid/);
});
test("ScummVM release discovery fetches multiple versions, skips missing Mac assets, and preserves immutable identities", async () => {
  const calls = [], tags = ["2027.1.0", "2026.4.0", "2.9.1"].map((version, i) => ({ name: "v" + version, commit: { sha: String(i + 1).repeat(40) } }));
  const discover = Catalog.createDiscovery({ fetchTags: async () => tags, request: async url => {
    calls.push(url);
    if (url === Catalog.SOURCE_URL) return { status: 200, body: Buffer.from(tags.map(tag => `<a href="${tag.name.slice(1)}/">version</a>`).join("")) };
    if (url.includes("2027.1.0")) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: Buffer.from("a".repeat(64)) };
  } });
  const rows = await discover(); assert.equal(rows.length, 3); assert.equal(rows[0].asset, undefined);
  assert.match(rows[0].installReason, /not available/); assert.equal(rows[2].upstreamRevision, "3".repeat(40));
  assert.ok(rows[2].asset.url.endsWith("scummvm-2.9.1-macosx.dmg")); assert.equal(calls.length, 4);
});
test("ScummVM manager reads offline until explicit refresh and retains valid cache on failed refresh", async t => {
  const userDataDir = temporary(t); let calls = 0, fail = false;
  const manager = createManager({ discoverCatalog: async () => { calls++; if (fail) throw new Error("network failure");
    return [Catalog.DEFAULT_ENTRY, { ...Catalog.DEFAULT_ENTRY, version: "2.9.1", upstreamRevision: "a".repeat(40) }]; } });
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle"); assert.equal(calls, 0);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, "2026.4.0"); assert.equal(calls, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  const settings = { runtimes: { scummvm: { defaultVersion: "2026.4.0" } } }, entry = { runtimeData: { scummvm: { version: "2.9.1" } } };
  assert.equal(manager.resolveSelection(entry, settings, userDataDir).version, "2.9.1");
  fail = true; await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }), /network failure/);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2026.4.0", "2.9.1"]);
  const restarted = createManager({ discoverCatalog: async () => assert.fail("Cache reads must be offline") });
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["2026.4.0", "2.9.1"]);
});
test("ScummVM dmg extraction uses a read-only local mount and detaches after copy failures", async t => {
  const destination = temporary(t), calls = [];
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, undefined, {
    run: async (_command, args) => { calls.push(args); if (args[0] === "attach") fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "ScummVM.app")); },
    copy: () => { throw new Error("copy failure"); }
  }), /copy failure/);
  assert.ok(calls[0].includes("-readonly")); assert.equal(calls[1][0], "detach");
  assert.equal(fs.existsSync(calls[1][1]), false);
  await assert.rejects(extractDmg(path.join(destination, "wrong.zip"), destination), /disk image/);
});
test("ScummVM dmg extraction detaches after an interrupted attach", async t => {
  const destination = temporary(t), calls = [], controller = new AbortController();
  const interrupted = Object.assign(new Error("attach interrupted"), { name: "AbortError" });
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, controller.signal, {
    run: async (_command, args, options) => {
      calls.push(args);
      if (args[0] === "attach") {
        fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "ScummVM.app"));
        controller.abort(); throw interrupted;
      }
      assert.equal(options.signal, undefined);
    }, copy: () => assert.fail("Interrupted downloads must not copy a payload")
  }), interrupted);
  assert.equal(calls[1][0], "detach"); assert.equal(fs.existsSync(calls[1][1]), false);
});
