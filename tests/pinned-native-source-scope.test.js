const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Source = require("../src/modules/shared/runtime/pinned-native-build");
const Stage = require("../scripts/stage-native-runtimes.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-primary-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child"), primary = path.join(root, "primary");
  const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  for (const directory of [child, primary]) {
    fs.mkdirSync(directory); git(directory, "init");
    git(directory, "config", "user.name", "Test Author"); git(directory, "config", "user.email", "test@example.invalid");
  }
  fs.writeFileSync(path.join(child, "unused.c"), "int unused(void) { return 1; }\n");
  git(child, "add", "."); git(child, "-c", "commit.gpgsign=false", "commit", "-m", "Child source");
  const childRevision = git(child, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(primary, "nested"));
  fs.writeFileSync(path.join(primary, "nested/main.c"), "int main(void) { return 0; }\n");
  fs.symlinkSync("nested/main.c", path.join(primary, "source-link.c"));
  const omittedPath = "third_party/unused";
  fs.writeFileSync(path.join(primary, ".gitmodules"), '[submodule "unused"]\n\tpath = third_party/unused\n\turl = ../child\n');
  git(primary, "add", ".");
  git(primary, "update-index", "--add", "--cacheinfo", `160000,${childRevision},${omittedPath}`);
  fs.mkdirSync(path.join(primary, omittedPath), { recursive: true });
  git(primary, "-c", "commit.gpgsign=false", "commit", "-m", "Primary source with unused child");
  const revision = git(primary, "rev-parse", "HEAD"), sourceScope = { kind: "primary-tree", omittedSubmodules: [omittedPath] };
  return { root, primary, child, git, revision, childRevision, omittedPath, sourceScope };
}

test("primary-tree scope verifies a real Git parent without fetching its unused child", async t => {
  const f = fixture(t);
  await assert.rejects(Source.validatePinnedSource(f.primary, f.revision), /submodules are missing/);
  const source = await Source.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope });
  assert.deepEqual(source.omittedSubmodules, [{ path: f.omittedPath, revision: f.childRevision }]);
  assert.deepEqual(source.files.sort(), [".gitmodules", "nested/main.c", "source-link.c"]);
  const before = Source.hashPinnedFiles(f.primary, source.files), staged = path.join(f.root, "staged");
  assert.equal(Source.stagePinnedFiles(f.primary, source.files, staged), before);
  assert.equal(fs.readFileSync(path.join(staged, ".gitmodules"), "utf8"), fs.readFileSync(path.join(f.primary, ".gitmodules"), "utf8"));
  assert.equal(fs.readlinkSync(path.join(staged, "source-link.c")), "nested/main.c");
  assert.equal(fs.existsSync(path.join(staged, f.omittedPath)), false);
  assert.equal(f.git(f.primary, "status", "--porcelain=v1", "--ignore-submodules=all"), "");
  fs.writeFileSync(path.join(f.primary, f.omittedPath, "untracked-child.txt"), "Unused input\n");
  assert.equal(Source.hashPinnedFiles(f.primary, (await Source.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope })).files), before);
  fs.appendFileSync(path.join(f.primary, "nested/main.c"), "/* changed primary input */\n");
  assert.notEqual(Source.hashPinnedFiles(f.primary, source.files), before);
  await assert.rejects(Source.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope }), /tracked changes/);
});

test("scopes reject unsafe shapes and missing, extra or unknown direct Gitlinks", async t => {
  const f = fixture(t);
  for (const scope of [null, [], {}, { kind: "recursive", omittedSubmodules: [f.omittedPath] },
    { ...f.sourceScope, ignoredFiles: ["nested/main.c"] }, { ...f.sourceScope, omittedSubmodules: [] },
    { ...f.sourceScope, omittedSubmodules: [f.omittedPath, f.omittedPath] },
    ...["../escape", "/absolute", "C:/absolute", "a\\b", "a//b", "a/.git/b", "a\nb", "a\0b"].map(value => ({ ...f.sourceScope, omittedSubmodules: [value] }))]) {
    await assert.rejects(Source.validatePinnedSource(f.primary, f.revision, { sourceScope: scope }), /Primary source scopes/);
  }
  for (const omittedSubmodules of [["third_party/unknown"], [f.omittedPath, "third_party/extra"], ["third_party"]]) {
    await assert.rejects(Source.validatePinnedSource(f.primary, f.revision, { sourceScope: { ...f.sourceScope, omittedSubmodules } }), /every direct pinned Git submodule/);
  }
  await assert.rejects(Source.validatePinnedSource(f.primary, "a".repeat(40), { sourceScope: f.sourceScope }), /revision mismatch/);
});

test("staging takes omissions only from the exact catalog and binds descriptor revisions and the full primary hash", async t => {
  const f = fixture(t), source = await Source.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope });
  const pin = { upstreamRevision: f.revision, sourceScope: f.sourceScope, sourceTreeSha256: Source.hashPinnedFiles(f.primary, source.files) };
  const input = { provenance: { verifiedBuild: true, sourceRevision: f.revision, sourceTreeSha256: pin.sourceTreeSha256,
    sourceScope: f.sourceScope, omittedSubmodules: source.omittedSubmodules } };
  assert.deepEqual(await Stage.validateArtifactSource(input, f.primary, f.revision, pin), source);
  for (const modify of [value => { value.provenance.verifiedBuild = false; }, value => { delete value.provenance.sourceScope; },
    value => { value.provenance.sourceScope.omittedSubmodules = ["third_party/unknown"]; },
    value => { value.provenance.sourceKind = "official-release"; }, value => { value.provenance.sourceKind = "reviewed-binary"; },
    value => { value.provenance.sourceTreeSha256 = "b".repeat(64); },
    value => { value.provenance.omittedSubmodules[0].revision = "c".repeat(40); }]) {
    const changed = structuredClone(input); modify(changed);
    await assert.rejects(Stage.validateArtifactSource(changed, f.primary, f.revision, pin), /scope|descriptors/);
  }
  await assert.rejects(Stage.validateArtifactSource(input, f.primary, f.revision, {}), /explicit matching catalog scope/);
  const wrongTree = { ...pin, sourceTreeSha256: "b".repeat(64) };
  await assert.rejects(Stage.validateArtifactSource({ provenance: { ...input.provenance, sourceTreeSha256: wrongTree.sourceTreeSha256 } }, f.primary, f.revision, wrongTree), /tree checksum/);
  fs.appendFileSync(path.join(f.primary, ".gitmodules"), "# changed\n");
  await assert.rejects(Stage.validateArtifactSource(input, f.primary, f.revision, pin), /tracked changes/);
});

test("scoped source builds preserve the catalog scope and Gitlink descriptors in registration", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), installDir = path.join(f.root, "install"); let registered;
  const manager = { id: "fixture", core: { catalog: [{ version: "1.0.0", upstreamRevision: f.revision, sourceScope: f.sourceScope }],
    normalizeVersion: value => value, getInstallDir: () => installDir, resolveInstalled: () => null,
    registerLocal: input => { registered = input; return { version: input.version }; } } };
  await Source.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: f.primary, userDataDir: f.root,
    resolveExecutable: root => path.join(root, "fixture"), dependencies: { findBuildTool: () => "/usr/bin/true", runBuildCommand: async () => {} } });
  assert.deepEqual(registered.verifiedBuild.sourceScope, f.sourceScope);
  assert.deepEqual(registered.verifiedBuild.omittedSubmodules, [{ path: f.omittedPath, revision: f.childRevision }]);
  assert.equal(registered.verifiedBuild.sourceTreeSha256, Source.hashPinnedFiles(f.primary, [".gitmodules", "nested/main.c", "source-link.c"]));
});

test("native staging rechecks scoped Git inputs after signing and removes failed output", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
  const f = fixture(t), source = await Source.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope });
  const executable = path.join(f.root, "runner"), notice = path.join(f.root, "LICENSE");
  execFileSync("/usr/bin/clang", ["-arch", "arm64", "-mmacosx-version-min=13.0", path.join(f.primary, "nested/main.c"), "-o", executable], { stdio: "pipe" });
  fs.writeFileSync(notice, "Fixture source is available under MIT.\n");
  const pin = { version: "0.7.7beta-macos-scope-fixture", upstreamRevision: f.revision,
    sourceTreeSha256: Source.hashPinnedFiles(f.primary, source.files), sourceScope: f.sourceScope,
    hostArchitectures: ["arm64"], minimumMacOS: "13.0" };
  const input = { managerId: "onsyuri", version: pin.version, sourceRoot: f.primary, executable,
    expectedInputSha256: require("../src/modules/shared/runtime/local-native").hashFile(executable),
    notices: [{ file: notice, name: "Fixture source", license: "MIT", sourceUrl: "https://example.invalid/source" }],
    provenance: { verifiedBuild: true, sourceRevision: f.revision, sourceTreeSha256: pin.sourceTreeSha256, sourceScope: f.sourceScope } };
  const stagingCatalog = { schemaVersion: 1, managers: [{ id: "onsyuri", distributionArchitectures: { arm64: ["arm64"], x64: [] }, catalog: [pin] }] };
  const result = await Stage.stagePackage(input, { outputRoot: path.join(f.root, "positive"), arch: "arm64", stagingCatalog });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.provenance.sourceScope, f.sourceScope);
  assert.deepEqual(manifest.provenance.omittedSubmodules, source.omittedSubmodules);
  let changed = false;
  const tool = (command, args) => {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: "pipe" });
    if (!changed && command === "/usr/bin/codesign" && args[0] === "--verify") {
      changed = true; fs.appendFileSync(path.join(f.primary, "nested/main.c"), "/* changed after signing */\n");
    }
    return output;
  };
  const failedRoot = path.join(f.root, "negative");
  await assert.rejects(Stage.stagePackage(input, { outputRoot: failedRoot, arch: "arm64", stagingCatalog, tool }), /tracked changes/);
  assert.equal(changed, true);
  const targetParent = path.join(failedRoot, "onsyuri", pin.version);
  assert.equal(fs.existsSync(path.join(targetParent, "arm64")), false);
  assert.deepEqual(fs.readdirSync(targetParent), []);
});
