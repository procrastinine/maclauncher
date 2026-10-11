const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const Source = require("../src/modules/shared/runtime/pinned-native-build");
const { resolveStagingPin, validateCandidateSource, validateAdditionalSources, verifyAdditionalSources, additionalSourceIdentities } = require("../scripts/stage-native-runtimes.cjs");

function fixture() {
  const revision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64);
  const existing = createPinnedNativeManager({ id: "fixture", label: "Fixture", catalog: [{ version: "1.0.0", upstreamRevision: revision }] });
  const managerCatalog = new Map([[existing.id, existing]]);
  const input = { managerId: "fixture", version: "1.0.0-macos-v2" };
  const pin = { version: input.version, upstreamRevision: revision, sourceTreeSha256, minimumMacOS: "13.0", hostArchitectures: ["arm64"] };
  const stagingCatalog = { schemaVersion: 1, managers: [{ id: existing.id, distributionArchitectures: { arm64: ["arm64"], x64: [] }, catalog: [pin] }] };
  return { existing, managerCatalog, input, pin, stagingCatalog };
}

test("explicit source candidate staging validates a separate catalog without changing canonical pins", () => {
  const f = fixture(), before = structuredClone(f.existing.core.catalog);
  const selected = resolveStagingPin(f.input, { arch: "arm64", managerCatalog: f.managerCatalog, stagingCatalog: f.stagingCatalog });
  assert.equal(selected.candidate, true); assert.equal(selected.manager, f.existing);
  assert.deepEqual(selected.pin, f.pin); assert.notEqual(selected.pin, f.pin);
  assert.deepEqual(f.existing.core.catalog, before);
  assert.throws(() => resolveStagingPin(f.input, { managerCatalog: f.managerCatalog }), /Unknown pinned/);
  const original = resolveStagingPin({ ...f.input, version: "1.0.0" }, { managerCatalog: f.managerCatalog });
  assert.equal(original.candidate, false); assert.equal(original.pin.version, "1.0.0");
});

test("candidate staging rejects incomplete, ambiguous and unsafe source identities", () => {
  for (const change of [
    p => { delete p.upstreamRevision; }, p => { p.upstreamRevision = "short"; },
    p => { delete p.sourceTreeSha256; }, p => { p.sourceTreeSha256 = "c".repeat(40); },
    p => { p.version = "../candidate"; }, p => { p.version = "candidate\0"; },
    p => { p.minimumMacOS = "latest"; }, p => { p.hostArchitectures = []; },
    p => { p.hostArchitectures = ["arm64", "arm64"]; }, p => { p.hostArchitectures = ["x86_64"]; },
    p => { p.hostArchitectures = ["x64"]; }, p => { p.asset = { url: "https://example.invalid/runtime.tar.gz", sha256: "d".repeat(64), filename: "runtime.tar.gz" }; },
    p => { p.localBuild = false; }, p => { p.publishedBinary = {}; }, p => { p.overlaySha256 = "short"; }
  ]) {
    const f = fixture(); change(f.pin);
    assert.throws(() => resolveStagingPin(f.input, { arch: "arm64", managerCatalog: f.managerCatalog, stagingCatalog: f.stagingCatalog }));
  }
  const f = fixture(); f.stagingCatalog.managers[0].catalog.push({ ...f.pin });
  assert.throws(() => resolveStagingPin(f.input, { arch: "arm64", managerCatalog: f.managerCatalog, stagingCatalog: f.stagingCatalog }), /unique safe/);
});

test("candidate staging cannot shadow canonical versions or omit a requested architecture", () => {
  const f = fixture();
  const resolve = catalog => resolveStagingPin(f.input, { arch: "arm64", managerCatalog: f.managerCatalog, stagingCatalog: catalog });
  const canonical = structuredClone(f.stagingCatalog); canonical.managers[0].catalog[0].version = "1.0.0";
  assert.throws(() => resolve(canonical), /cannot override/);
  const missing = structuredClone(f.stagingCatalog); missing.managers[0].catalog[0].version = "other";
  assert.throws(() => resolve(missing), /does not pin/);
  const unknown = structuredClone(f.stagingCatalog); unknown.managers[0].id = "unknown";
  assert.throws(() => resolve(unknown), /known, unique/);
  for (const mapping of [undefined, {}, [], { arm64: ["arm64", "arm64"] }, { arm64: ["x86_64"] }]) {
    const next = structuredClone(f.stagingCatalog); next.managers[0].distributionArchitectures = mapping;
    assert.throws(() => resolve(next), /architecture|artifact/);
  }
  assert.throws(() => resolveStagingPin(f.input, { arch: "x64", managerCatalog: f.managerCatalog, stagingCatalog: f.stagingCatalog }), /no x64 artifact/);
  assert.throws(() => resolve({ ...f.stagingCatalog, schemaVersion: 2 }), /schema version/);
  assert.throws(() => resolve({ ...f.stagingCatalog, managers: [] }), /schema version/);
  assert.throws(() => resolve({ ...f.stagingCatalog, managers: [f.stagingCatalog.managers[0], f.stagingCatalog.managers[0]] }), /unique/);
  const privatePath = structuredClone(f.stagingCatalog); privatePath.managers[0].catalog[0].buildPath = "/tmp/private-candidate/source";
  assert.throws(() => resolve(privatePath), /private filesystem/);
});

test("candidate source checks bind the exact clean-source digest and optional overlay", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-staging-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "source.c"), "int value(void) { return 7; }\n");
  const files = ["source.c"], f = fixture(); f.pin.sourceTreeSha256 = Source.hashPinnedFiles(root, files);
  const input = { provenance: { verifiedBuild: true, sourceRevision: f.pin.upstreamRevision, sourceTreeSha256: f.pin.sourceTreeSha256 } };
  assert.doesNotThrow(() => validateCandidateSource(input, root, { files }, f.pin));
  for (const provenance of [undefined, { ...input.provenance, verifiedBuild: false },
    { ...input.provenance, sourceTreeSha256: "c".repeat(64) }, { ...input.provenance, sourceRevision: "d".repeat(40) },
    { ...input.provenance, overlaySha256: "e".repeat(64) }]) {
    assert.throws(() => validateCandidateSource({ provenance }, root, { files }, f.pin), /differs from its staging pin/);
  }
  fs.appendFileSync(path.join(root, "source.c"), "/* changed */\n");
  assert.throws(() => validateCandidateSource(input, root, { files }, f.pin), /tree checksum/);
  assert.throws(() => validateCandidateSource(input, root, {}, f.pin), /provenance/);
});
test("independent source inputs bind exact Git trees, retain private paths separately and recheck changes", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-extra-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), secondary = path.join(root, "secondary"); fs.mkdirSync(primary); fs.mkdirSync(secondary);
  const git = args => execFileSync('git', ['-C', secondary, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.writeFileSync(path.join(secondary, 'source.c'), 'int value(void) { return 7; }\n');
  git(['init']); git(['config', 'user.name', 'Test Author']); git(['config', 'user.email', 'test@example.invalid']);
  git(['add', 'source.c']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Source fixture']);
  const identity = { id: 'dependency', upstreamRevision: git(['rev-parse', 'HEAD']), sourceTreeSha256: Source.hashPinnedFiles(secondary, ['source.c']) };
  const pin = { additionalSources: [identity] }, input = { additionalSources: [{ ...identity, sourceRoot: secondary }],
    provenance: { verifiedBuild: true, additionalSources: [identity] } };
  const jobs = await validateAdditionalSources(input, pin, primary); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].identity, identity); assert.equal(Object.hasOwn(jobs[0].identity, 'sourceRoot'), false);
  for (const change of [
    value => { value.additionalSources = []; }, value => { value.additionalSources.push({ ...value.additionalSources[0] }); },
    value => { value.additionalSources[0].id = 'unlisted'; }, value => { value.additionalSources[0].sourceTreeSha256 = '0'.repeat(64); },
    value => { value.provenance.additionalSources = []; }, value => { value.additionalSources[0].sourceRoot = primary; },
    value => { value.additionalSources[0].extra = 'unlisted'; }
  ]) { const changed = structuredClone(input); change(changed); await assert.rejects(validateAdditionalSources(changed, pin, primary), /Additional source/); }
  const alias = path.join(root, 'alias'); fs.symlinkSync(secondary, alias);
  await assert.rejects(validateAdditionalSources({ ...input, additionalSources: [{ ...identity, sourceRoot: alias }] }, pin, primary), /real directories/);
  fs.appendFileSync(path.join(secondary, 'source.c'), '/* changed */\n');
  await assert.rejects(verifyAdditionalSources(jobs), /changes|checksum/);
  assert.throws(() => additionalSourceIdentities([{ ...identity, sourceRoot: secondary }]), /exact revision/);
  assert.throws(() => additionalSourceIdentities(Array(17).fill(identity)), /bounded/);
  assert.deepEqual(await validateAdditionalSources({}, {}, primary), []);
});
