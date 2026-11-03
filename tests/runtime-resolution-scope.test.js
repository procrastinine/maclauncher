const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Builds = require("../src/modules/rgss/runtime/mkxpz-builds");
const { createRuntimeUseScope, withRuntimeUseScope, withRuntimeMutation, instrumentRuntimeManagers,
  memoizeRuntimeResolution } = require("../src/core/coordinated-runtime-managers");

test("MKXP resolution reuse belongs to one preparation and ends across mutations, binding and release", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "resolution-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, "installed"), payload = path.join(installDir, "files");
  fs.mkdirSync(payload, { recursive: true }); fs.writeFileSync(path.join(installDir, "runtime.json"), "{}");
  fs.writeFileSync(path.join(payload, "entry"), "owned", { mode: 0o644 });
  const declaration = { files: [{ path: "entry", size: 5, mode: 0o644, sha256: Bundled.digest(Buffer.from("owned")) }] };
  const calls = [], uses = [], bindings = [], releases = [];
  let payloadChecks = 0, token = 0;
  const verify = Bundled.verifyPayload;
  t.mock.method(Bundled, "verifyPayload", (...args) => { payloadChecks++; return verify(...args); });
  const manager = { id: "mkxpz", core: { getInstallDir: () => installDir },
    resolveSelection(entry, settings, userDataDir, options) {
      calls.push({ entry, settings, userDataDir, options });
      return options.version === "broken" ? { ready: false } : { version: options.version, ready: true,
        install: { version: options.version, architecture: options.architecture, installDir,
          root: payload, payloadRoot: payload, declaration, manifest: { executableRelative: "Owned.app/Contents/MacOS/entry" } } };
    } };
  instrumentRuntimeManagers([manager]);
  const coordinator = { acquireUse: async identity => { uses.push(identity); return ++token; },
    acquireMutation: async (_identity, allowed) => { assert.ok(Array.isArray(allowed)); return ++token; },
    release: async value => { releases.push(value); }, extendMutation: async () => {},
    bindUse: async (lease, pid) => { bindings.push([lease, pid]); } };
  const scope = () => createRuntimeUseScope({ coordinator, managers: [manager], userDataDir: root });
  const lookup = (extra = {}) => Builds.resolveOwned({ userDataDir: root, version: "1", architecture: "arm64", ...extra }, manager);

  lookup(); lookup();
  assert.equal(calls.length, 2, "ordinary calls outside launch preparation resolve every time");
  assert.equal(payloadChecks, 2);
  const first = scope();
  await withRuntimeUseScope(first, async () => {
    const before = calls.length, verified = payloadChecks, installed = lookup();
    for (let i = 0; i < 15; i++) assert.equal(lookup(), installed);
    assert.equal(calls.length, before + 1); assert.equal(payloadChecks, verified + 1, "first full resolution still verifies actual payload bytes");
    assert.deepEqual(calls.at(-1), { entry: null, settings: {}, userDataDir: root,
      options: { version: "1", architecture: "arm64", verification: "full" } });
    await first.flushSelections();
    assert.equal(uses.length, 1); assert.equal(uses[0].managerId, "mkxpz"); assert.equal(uses[0].version, "1");
    assert.equal(uses[0].sourcePath, installDir, "the original successful selection still records its exact artifact lease");

    lookup({ verification: "status" }); lookup({ verification: "status" });
    assert.equal(calls.length, before + 2); assert.equal(payloadChecks, verified + 1, "status has its own unchanged verification semantics");
    lookup(); assert.equal(calls.length, before + 2);
    assert.equal(lookup({ architecture: "x64" }).architecture, "x64");
    assert.equal(lookup({ version: "2" }).version, "2");
    assert.equal(calls.length, before + 4, "architecture and exact version never share cached results");
    lookup(); await first.flushSelections();
    assert.equal(uses.at(-1).version, "1", "v1 -> v2 -> cached v1 replays the exact selection effects before leasing");
    assert.equal(uses.at(-1).sourcePath, installDir);
    const beforeSameObject = uses.length, repeatedIdentity = { managerId: "mkxpz", version: "1", sectionId: "default", sourcePath: installDir };
    const recordingOwner = {};
    memoizeRuntimeResolution(recordingOwner, "v1", () => { first.recordSelection(repeatedIdentity); return { ready: true }; });
    first.recordSelection({ ...repeatedIdentity, version: "2" });
    memoizeRuntimeResolution(recordingOwner, "v1", () => assert.fail("cached identity must replay without resolving"));
    await first.flushSelections();
    assert.equal(uses.at(-1).version, "1"); assert.equal(uses.length, beforeSameObject, "replaying the same identity object keeps its existing exact lease");

    fs.unlinkSync(path.join(installDir, "runtime.json"));
    assert.equal(lookup({ version: "missing" }), null); assert.equal(lookup({ version: "missing" }), null);
    fs.writeFileSync(path.join(installDir, "runtime.json"), "{}");
    assert.equal(lookup({ version: "missing" }).version, "missing", "missing results are not remembered");
    const damaged = calls.length;
    assert.throws(() => lookup({ version: "broken" }), /damaged/);
    assert.throws(() => lookup({ version: "broken" }), /damaged/);
    assert.equal(calls.length, damaged + 2, "throwing/failed resolutions never become ready");

    for (const failure of [false, true]) {
      const atMutation = calls.length;
      const mutate = () => withRuntimeMutation({ managerId: "mkxpz", version: "1" }, async () => {
        lookup(); lookup();
        if (failure) throw Error("mutation failed");
      }, { coordinator, userDataDir: root });
      if (failure) await assert.rejects(mutate, /mutation failed/); else await mutate();
      assert.equal(calls.length, atMutation + 2, "lookups during mutation bypass reuse");
      lookup(); lookup(); assert.equal(calls.length, atMutation + 3, "success and failure both clear the previous preparation result");
    }
    for (const failure of [false, true]) {
      const beforeMutable = calls.length;
      const mutate = () => first.withMutablePreparation({ managerId: "mkxpz", version: "1" }, async () => {
        lookup(); lookup();
        if (failure) throw Error("preparation failed");
      });
      if (failure) await assert.rejects(mutate, /preparation failed/); else await mutate();
      assert.equal(calls.length, beforeMutable + 2);
      lookup(); lookup(); assert.equal(calls.length, beforeMutable + 3);
    }

    const otherOwner = {}, owner = {}, value = { ready: true };
    let attempts = 0;
    const positive = () => { attempts++; return value; };
    memoizeRuntimeResolution(owner, "same", positive); memoizeRuntimeResolution(otherOwner, "same", positive);
    assert.equal(attempts, 2, "different resolver owners never share a result");
    for (const result of [null, false, { ready: false }]) {
      const negative = () => { attempts++; return result; };
      const previous = attempts;
      memoizeRuntimeResolution(owner, "negative", negative); memoizeRuntimeResolution(owner, "negative", negative);
      assert.equal(attempts, previous + 2);
    }
    const previousAsync = attempts;
    const asynchronous = async () => { attempts++; return value; };
    await memoizeRuntimeResolution(owner, "async", asynchronous); await memoizeRuntimeResolution(owner, "async", asynchronous);
    assert.equal(attempts, previousAsync + 2, "only synchronous results participate");

    await first.bind(4242); assert.ok(bindings.length > 0);
    const bound = calls.length; lookup(); lookup(); assert.equal(calls.length, bound + 2);
    await first.release();
    const released = calls.length; lookup(); lookup(); assert.equal(calls.length, released + 2);
  });
  const second = scope();
  await withRuntimeUseScope(second, async () => {
    const before = calls.length; lookup(); lookup(); assert.equal(calls.length, before + 1, "a new launch verifies its first resolution again");
    await second.release();
  });
  assert.ok(releases.length > 0);
});
