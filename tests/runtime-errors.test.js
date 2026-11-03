const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { sanitizeErrorMessage, sanitizeRuntimeErrors } = require("../src/core/runtime-errors.mjs");
const { snapshotRuntimeState, restoreRuntimeState } = require("../src/core/runtime-state-snapshot.mjs");
const Catalog = require("../src/modules/shared/runtime/runtime-catalog");
const fake = "Download failed through http://fixture-user:fixture-p%40ss@proxy.example.test:8080 while requesting https://github.com/example/runtime";
const clean = fake.replace("fixture-user:fixture-p%40ss@", "");
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("one sanitizer removes URL credentials without losing endpoints or ordinary error details", () => {
  for (const value of [fake, new Error(fake), { message: fake }]) assert.ok(sanitizeErrorMessage(value).endsWith(clean));
  assert.equal(sanitizeErrorMessage("socks5h://fake:password@with-at@proxy.example.test:123 /tmp/file"),
    "socks5h://proxy.example.test:123 /tmp/file");
  assert.equal(sanitizeErrorMessage("https://fake%40user:fake%2Fpassword@[::1]:8080/a?x=1"), "https://[::1]:8080/a?x=1");
  assert.equal(sanitizeErrorMessage("https://github.com/example/runtime?owner=a@b"), "https://github.com/example/runtime?owner=a@b");
  assert.equal(sanitizeErrorMessage("Missing /tmp/runtime\nRequires macOS 13."), "Missing /tmp/runtime\nRequires macOS 13.");
});

test("legacy and compact UI snapshots sanitize nested errors before persistence and when read without mutating inputs", t => {
  const root = temporary(t), catalog = { error: fake, installReason: fake, sourceStates: { upstream: { error: fake } },
    architectureCatalogs: { x64: { versionRequirements: { v1: { variants: { metal: { installReason: fake } } } } } } };
  const raw = { installed: [{ version: "v1", error: fake }], catalog, sections: [{ id: "default", catalog }] };
  const before = JSON.stringify(raw), file = path.join(root, "ui-state-cache.json");
  const wire = snapshotRuntimeState(raw); fs.writeFileSync(file, JSON.stringify({ runtimeManagers: { fixture: wire } }));
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /fixture-user|fixture-p%40ss/);
  assert.equal(JSON.stringify(raw), before);
  for (const stored of [raw, wire]) {
    const read = restoreRuntimeState(stored);
    assert.equal(read.catalog.error, clean); assert.equal(read.catalog.installReason, clean);
    assert.equal(read.catalog.architectureCatalogs.x64.versionRequirements.v1.variants.metal.installReason, clean);
    assert.equal(read.sections[0].catalog, read.catalog, "shared facts retain their references");
    assert.doesNotMatch(JSON.stringify(read), /fixture-user|fixture-p%40ss/);
  }
  const envelope = sanitizeRuntimeErrors({ runtimeManagers: { fixture: raw }, moduleStates: { fixture: { error: fake } } });
  assert.equal(envelope.moduleStates.fixture.error, clean);
  assert.doesNotMatch(JSON.stringify(envelope), /fixture-user|fixture-p%40ss/);
});

test("catalog writes redact errors and installation reasons; legacy reads redact without migrating the file", t => {
  const root = temporary(t), args = { userDataDir: root, managerId: "fake-runtime", entries: [{ version: "1", installReason: fake }],
    sourceStates: { upstream: { status: "error", error: fake, failedAt: 1900000000000 } } };
  Catalog.writeRuntimeCatalog(args);
  const file = Catalog.catalogPath(root, args.managerId);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /fixture-user|fixture-p%40ss/);
  const legacy = JSON.parse(fs.readFileSync(file, "utf8")); legacy.sourceStates.upstream.error = fake; legacy.entries[0].installReason = fake;
  const bytes = JSON.stringify(legacy); fs.writeFileSync(file, bytes);
  const read = Catalog.readRuntimeCatalog(args);
  assert.equal(read.sourceStates.upstream.error, clean); assert.equal(read.entries[0].installReason, clean);
  assert.equal(read.sourceStates.upstream.failedAt, 1900000000000);
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "ordinary reads do not rewrite an existing cache");
});

test("native catalog failures record their own time while retaining last-success rows and clearing the failure after retry", async t => {
  const root = temporary(t), { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
  let now = 1900000000000, fail = false;
  t.mock.method(Date, "now", () => now);
  const runtime = createPinnedNativeManager({ id: "fake-runtime", label: "Fake runtime", discoverCatalog: async () => {
    if (fail) throw new Error(fake);
    return [{ version: "1", upstreamRevision: "fixture" }];
  } });
  await runtime.refreshCatalog({ userDataDir: root });
  const first = runtime.getState({ userDataDir: root }).catalog;
  const succeededAt = first.fetchedAt;
  now += 1000; fail = true;
  await assert.rejects(runtime.refreshCatalog({ userDataDir: root, force: true }), /Download failed/);
  const failed = runtime.getState({ userDataDir: root }).catalog;
  assert.equal(failed.failedAt, now); assert.equal(failed.fetchedAt, succeededAt);
  assert.deepEqual(failed.versions, first.versions); assert.equal(failed.error, clean);
  for (const source of Object.values(failed.sourceStates)) { assert.equal(source.failedAt, now); assert.equal(source.error, clean); }
  const restored = restoreRuntimeState(JSON.parse(JSON.stringify(snapshotRuntimeState({ catalog: failed }))));
  assert.equal(restored.catalog.failedAt, now);
  now += 1000; fail = false;
  await runtime.refreshCatalog({ userDataDir: root });
  const retried = runtime.getState({ userDataDir: root }).catalog;
  assert.equal(retried.error, null); assert.equal(retried.failedAt, undefined); assert.equal(retried.fetchedAt, now);
});
