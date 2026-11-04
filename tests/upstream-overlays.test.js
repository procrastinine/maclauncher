const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Check = require("../scripts/check-upstream-overlays.cjs");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "MacLauncher fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "MacLauncher fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function git(directory, ...args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", directory, ...args], { encoding: "utf8", env: ENV }).trim();
}
function write(root, filename, text) {
  const file = path.join(root, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-upstream-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  const source = path.join(root, "src/external/fixture"); fs.mkdirSync(source, { recursive: true }); git(source, "init", "-q");
  git(source, "config", "remote.origin.url", "https://example.invalid/fixture.git");
  write(source, "engine.c", "reviewed source\n"); git(source, "add", "engine.c"); git(source, "commit", "-qm", "Fixture source");
  const revision = git(source, "rev-parse", "HEAD");
  write(root, ".gitmodules", '[submodule "fixture"]\n path = src/external/fixture\n url = https://example.invalid/fixture.git\n');
  git(root, "add", ".gitmodules"); git(root, "update-index", "--add", "--cacheinfo", `160000,${revision},src/external/fixture`);
  write(root, "scripts/pin.json", JSON.stringify({ revision }));
  const applyFile = "src/modules/fixture/overlays/apply.cjs";
  write(root, applyFile, 'const fs=require("node:fs");const path=require("node:path");exports.apply=stage=>{fs.appendFileSync(path.join(stage,"engine.c"),"owned adaptation\\n");fs.writeFileSync(path.join(stage,"helper.c"),"owned helper\\n");return {sourceWasCopied:!fs.existsSync(path.join(stage,".git"))};};\n');
  write(root, "tests/focused.test.js", "// A declared focused check.\n");
  const inventory = { schemaVersion: 1, projects: [{ id: "fixture", path: "src/external/fixture", repository: "https://example.invalid/fixture", revision,
    pinRefs: [{ kind: "json", path: "scripts/pin.json", property: "revision" }] }], recipes: [{ id: "fixture-overlay", project: "fixture", kind: "source-overlay",
    ownedFiles: [{ path: applyFile, sha256: sha(fs.readFileSync(path.join(root, applyFile))) }], buildEntries: [applyFile], tests: ["tests/focused.test.js"],
    reviewedOriginalFiles: { "engine.c": sha("reviewed source\n"), "helper.c": null },
    reviewedAdaptedFiles: { "engine.c": sha("reviewed source\nowned adaptation\n"), "helper.c": sha("owned helper\n") },
    guards: [{ root: "$stage", sourceProject: "fixture", files: { "engine.c": sha("reviewed source\n") } }],
    operations: [{ kind: "call", module: applyFile, export: "apply", arguments: ["$stage"] }] }] };
  return { root, source, revision, inventory, applyFile };
}

test("offline audit agrees on Git, catalog and owned source evidence without contacting an origin", async t => {
  const current = fixture(t);
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true);
  assert.equal(report.topLevelSubmodules, 1);
  assert.deepEqual(report.warnings, []);
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
});

test("Gitlink-only source records retain exact offline and candidate checks", async t => {
  const current = fixture(t);delete current.inventory.projects[0].revision;
  const offline = await Check.checkInventory(current);
  assert.equal(offline.passed,true);assert.equal(offline.checked[0].revision,current.revision);
  const candidate = await Check.checkCandidate({...current,projectId:"fixture",workDir:path.join(current.root,".local/gitlink-only")});
  assert.equal(candidate.passed,true);assert.equal(candidate.reviewedRevision,current.revision);
  assert.equal(current.inventory.projects[0].revision,undefined);
  fs.appendFileSync(path.join(current.source,"engine.c"),"changed input\n");
  assert.ok((await Check.checkInventory(current)).errors.some(issue=>issue.code==="tracked-source-modified"));
});

test("an explicitly reviewed checkout mirror preserves independent declared-origin and exact-pin checks", async t => {
  const current = fixture(t), project = current.inventory.projects[0];
  git(current.source, "config", "remote.origin.url", "https://mirror.example.invalid/fixture.git");
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "checkout-origin-drift"));
  project.checkoutOrigin = "https://mirror.example.invalid/fixture.git";
  assert.throws(() => Check.validateInventory(current.inventory), /recorded origin reason/);
  project.checkoutOriginReason = "Reviewed public mirror of the same pinned commit; canonical module metadata remains unchanged.";
  assert.equal((await Check.checkInventory(current)).passed, true);
  git(current.source, "config", "remote.origin.url", project.repository + ".git");
  assert.equal((await Check.checkInventory(current)).passed, true, "The declared primary origin stays valid when a mirror is configured");
  write(current.root, ".gitmodules", '[submodule "fixture"]\n path = src/external/fixture\n url = https://mirror.example.invalid/fixture.git\n');
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "declared-origin-drift"));
  git(current.source, "config", "remote.origin.url", "https://another.example.invalid/fixture.git");
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "checkout-origin-drift"));
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
});

test("offline audit detects a Git index entry whose submodule configuration was removed", async t => {
  const current = fixture(t);
  fs.rmSync(path.join(current.root, ".gitmodules"));
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, false);
  assert.ok(report.errors.some(issue => issue.code === "missing-submodule-metadata" && issue.id === "fixture"));
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
});

test("candidate nested sources use parent Gitlinks and metadata without inventory entries", async t => {
  const current = fixture(t);
  const child = path.join(current.source, "vendor/child"); fs.mkdirSync(child, { recursive: true }); git(child, "init", "-q");
  write(child, "dependency.c", "nested dependency\n"); git(child, "add", "dependency.c"); git(child, "commit", "-qm", "Nested fixture");
  write(current.source, ".gitmodules", '[submodule "child"]\n path = vendor/child\n url = https://example.invalid/child.git\n');
  git(current.source, "add", ".gitmodules");
  git(current.source, "update-index", "--add", "--cacheinfo", `160000,${git(child, "rev-parse", "HEAD")},vendor/child`);
  git(current.source, "commit", "-qm", "Parent with dependency");
  const revision = git(current.source, "rev-parse", "HEAD");
  current.inventory.projects[0].revision = revision;
  write(current.root, "scripts/pin.json", JSON.stringify({ revision }));
  git(current.root, "update-index", "--cacheinfo", `160000,${revision},src/external/fixture`);
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true);
  const workDir = path.join(current.root, ".local/unknown-nested");
  const candidate = await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir });
  assert.equal(candidate.passed, true);assert.equal(candidate.upstreamCheckoutUnchanged, true);
  assert.equal(fs.readFileSync(path.join(workDir,"fixture-overlay/source/vendor/child/dependency.c"),"utf8"),"nested dependency\n");
});

test("stale nested submodule declarations warn without inventing a pinned dependency", async t => {
  const current = fixture(t);
  write(current.source, ".gitmodules", '[submodule "stale"]\n path = vendor/stale\n url = https://example.invalid/stale.git\n');
  write(current.source, "vendor/stale/README.md", "An ordinary tracked directory, not a Gitlink.\n");
  git(current.source, "add", ".gitmodules", "vendor/stale/README.md");git(current.source, "commit", "-qm", "Stale nested declaration");
  const revision = git(current.source, "rev-parse", "HEAD");current.inventory.projects[0].revision = revision;
  write(current.root, "scripts/pin.json", JSON.stringify({ revision }));
  git(current.root, "update-index", "--cacheinfo", `160000,${revision},src/external/fixture`);
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true);
  assert.ok(report.warnings.some(issue => issue.code === "unused-submodule-declaration" && issue.path === "src/external/fixture/vendor/stale"));
  const candidate = await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir: path.join(current.root, ".local/stale-nested") });
  assert.equal(candidate.passed, true);assert.equal(candidate.upstreamCheckoutUnchanged, true);
  assert.ok(candidate.warnings.some(issue => issue.code === "unused-submodule-declaration" && issue.path === "src/external/fixture/vendor/stale"));
});

test("candidate scopes leave unrelated nested sources alone and require metadata for consumed sources", async t => {
  const current = fixture(t), childRevision = current.revision;
  git(current.source, "update-index", "--add", "--cacheinfo", `160000,${childRevision},vendor/undeclared`);
  git(current.source, "commit", "-qm", "Actual nested Gitlink without metadata");
  const revision = git(current.source, "rev-parse", "HEAD");current.inventory.projects[0].revision = revision;
  write(current.root, "scripts/pin.json", JSON.stringify({ revision }));
  git(current.root, "update-index", "--cacheinfo", `160000,${revision},src/external/fixture`);
  current.inventory.recipes[0].includePaths = ["engine.c"];
  assert.equal((await Check.checkInventory(current)).passed, true);
  assert.equal((await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir: path.join(current.root, ".local/unconsumed-nested") })).passed, true);
  current.inventory.recipes[0].includePaths.push("vendor/undeclared");
  await assert.rejects(Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir: path.join(current.root, ".local/missing-actual-metadata") }), /lacks .gitmodules metadata/);
});

test("candidate file scopes cross pinned nested Git trees without copying unrelated dependency files", async t => {
  const current = fixture(t), child = path.join(current.source, "vendor/child");
  fs.mkdirSync(child, { recursive: true }); git(child, "init", "-q");
  write(child, "selected.c", "selected dependency\n"); write(child, "unused.c", "unselected dependency\n");
  git(child, "add", "."); git(child, "commit", "-qm", "Scoped nested source");
  const childRevision = git(child, "rev-parse", "HEAD");
  write(current.source, ".gitmodules", '[submodule "child"]\n path = vendor/child\n url = https://example.invalid/child.git\n');
  git(current.source, "add", ".gitmodules");
  git(current.source, "update-index", "--add", "--cacheinfo", `160000,${childRevision},vendor/child`);
  git(current.source, "commit", "-qm", "Parent with scoped dependency");
  const revision = git(current.source, "rev-parse", "HEAD"); current.inventory.projects[0].revision = revision;
  current.inventory.recipes[0].sourceScopes = { fixture: ["engine.c", "vendor/child/selected.c"] };
  const workDir = path.join(current.root, ".local/scoped-candidate"), before = git(child, "status", "--porcelain");
  const report = await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir });
  assert.equal(report.passed, true); assert.equal(report.sourceCheckoutsChecked, 2); assert.equal(report.upstreamCheckoutUnchanged, true);
  const staged = path.join(workDir, 'fixture-overlay/source/vendor/child');
  assert.deepEqual(fs.readdirSync(staged), ['selected.c']);
  assert.equal(fs.readFileSync(path.join(staged, 'selected.c'), 'utf8'), 'selected dependency\n');
  assert.equal(git(child, "status", "--porcelain"), before);
  current.inventory.projects.push({ id: "fixture-child", path: "src/external/fixture/vendor/child", repository: "https://example.invalid/child", revision: 'a'.repeat(40) });
  await assert.rejects(Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir: path.join(current.root, '.local/changed-nested-pin') }), /nested source pin changed/);
});

test("offline source guards read exact nested Gitlink blobs and reject hash or origin drift", async t => {
  const current = fixture(t), child = path.join(current.source, "vendor/child");
  fs.mkdirSync(child, { recursive: true }); git(child, "init", "-q");
  git(child, "config", "remote.origin.url", "https://example.invalid/child.git");
  write(child, "selected.c", "nested guarded source\n");
  git(child, "add", "."); git(child, "commit", "-qm", "Nested guarded input");
  const childRevision = git(child, "rev-parse", "HEAD");
  write(current.source, ".gitmodules", '[submodule "child"]\n path = vendor/child\n url = https://example.invalid/child.git\n');
  git(current.source, "add", ".gitmodules");
  git(current.source, "update-index", "--add", "--cacheinfo", `160000,${childRevision},vendor/child`);
  git(current.source, "commit", "-qm", "Guarded dependency link");
  const revision = git(current.source, "rev-parse", "HEAD");
  current.inventory.projects[0].revision = revision;
  current.inventory.projects.push({ id: "fixture-child", parent: "fixture", path: "src/external/fixture/vendor/child",
    repository: "https://example.invalid/child", revision: childRevision,
    checkoutOrigin: "https://mirror.example.invalid/child", checkoutOriginReason: "Reviewed public mirror of the same exact source." });
  git(current.root, "update-index", "--add", "--cacheinfo", `160000,${revision},src/external/fixture`);
  write(current.root, "scripts/pin.json", JSON.stringify({ revision }));
  const guard = current.inventory.recipes[0].guards[0];
  guard.files["vendor/child/selected.c"] = sha("nested guarded source\n");
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  git(child, "config", "remote.origin.url", "https://mirror.example.invalid/child.git");
  assert.equal((await Check.checkInventory(current)).passed, true, "The nested guard accepts its exact declared mirror too");
  git(child, "config", "remote.origin.url", "https://example.invalid/child.git");
  guard.files["vendor/child/selected.c"] = "0".repeat(64);
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "original-source-evidence-drift"));
  git(child, "config", "remote.origin.url", "https://other.example.invalid/child.git");
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "original-source-evidence-unavailable"));
  assert.equal(git(current.source, "status", "--porcelain"), "");
  assert.equal(git(child, "status", "--porcelain"), "");
});

test("offline audit reports catalog and owned file drift instead of updating either", async t => {
  const current = fixture(t);
  write(current.root, "scripts/pin.json", JSON.stringify({ revision: "f".repeat(40) }));
  fs.appendFileSync(path.join(current.root, current.applyFile), "// changed recipe\n");
  const report = await Check.checkInventory(current);
  assert.ok(report.errors.some(issue => issue.code === "module-pin-drift"));
  assert.ok(report.errors.some(issue => issue.code === "owned-adaptation-drift"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(current.root, "scripts/pin.json"))).revision, "f".repeat(40));
});

test("offline audit checks adaptation versions and source archive pins independently of Git revisions", async t => {
  const current = fixture(t);
  const pins = { version: "profile-v2", archive: "a".repeat(64) };
  write(current.root, "scripts/profile.json", JSON.stringify(pins));
  current.inventory.recipes[0].version = "profile-v1";
  current.inventory.recipes[0].versionRefs = [{ kind: "json", path: "scripts/profile.json", property: "version" }];
  current.inventory.archiveInputs = [{ id: "archive", sha256: "b".repeat(64),
    pinRefs: [{ kind: "json", path: "scripts/profile.json", property: "archive" }] }];
  const report = await Check.checkInventory(current);
  assert.ok(report.errors.some(issue => issue.code === "adaptation-version-drift"));
  assert.ok(report.errors.some(issue => issue.code === "archive-pin-drift"));
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current.root, "scripts/profile.json"))), pins);
});

test("source recipes derive the package version from the selected app lock record", async t => {
  const current = fixture(t), recipe = current.inventory.recipes[0];
  const ref = { kind: "json", path: "build/runtime-packages.json", array: "packages",
    select: { id: "helper", arch: "universal" }, property: "version" };
  write(current.root, ref.path, JSON.stringify({ packages: [{ id: "helper", arch: "universal", version: "next-release" }] }));
  write(current.root, "scripts/source-version.json", JSON.stringify({ version: "next-release" }));
  recipe.version = ref;
  recipe.versionRefs = [{ kind: "json", path: "scripts/source-version.json", property: "version" }];
  assert.equal(Check.sourceRef(current.root, ref), "next-release");
  assert.equal((await Check.checkInventory(current)).passed, true);
  write(current.root, ref.path, JSON.stringify({ packages: [{ id: "helper", arch: "universal", version: "new-release" }] }));
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "adaptation-version-drift"));
});

test("explicit package revisions stay exact without changing the source adaptation version", async t => {
  const current = fixture(t), recipe = current.inventory.recipes[0];
  recipe.version = "0.5.0";
  write(current.root, "scripts/source-version.json", JSON.stringify({ version: "0.5.0" }));
  write(current.root, "scripts/package-versions.json", JSON.stringify([{ version: "0.5.0-MCLv2" }]));
  const packageRef = { kind: "json", path: "scripts/package-versions.json", select: { version: "0.5.0-MCLv2" }, property: "version" };
  recipe.versionRefs = [{ kind: "json", path: "scripts/source-version.json", property: "version" }, packageRef];
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "adaptation-version-drift"));
  packageRef.expectedVersion = "0.5.0-MCLv2";
  assert.equal((await Check.checkInventory(current)).passed, true);
  assert.equal(recipe.version, "0.5.0");
  packageRef.expectedVersion = "0.5.0-MCLv1";
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "adaptation-version-drift"));
  for (const invalid of ["", "   ", 2]) {
    packageRef.expectedVersion = invalid;
    assert.throws(() => Check.validateInventory(current.inventory), /expectedVersion.*nonempty explicit string/);
  }
});

test("JSON version references select exact records independently of catalog order", async t => {
  const current = fixture(t), filename = "scripts/versions.json";
  const versions = [{ version: "profile-v2", source: "b".repeat(64) }, { version: "profile-v1", source: "a".repeat(64) }];
  const selected = { kind: "json", path: filename, select: { version: "profile-v1" }, property: "version" };
  current.inventory.recipes[0].version = "profile-v1";
  current.inventory.recipes[0].versionRefs = [selected];
  write(current.root, filename, JSON.stringify(versions));
  assert.equal((await Check.checkInventory(current)).passed, true);
  write(current.root, filename, JSON.stringify([{ version: "profile-v3", source: "c".repeat(64) }, ...versions.reverse()]));
  const before = fs.readFileSync(path.join(current.root, filename));
  assert.equal(Check.sourceRef(current.root, { ...selected, property: "source" }), "a".repeat(64));
  assert.equal((await Check.checkInventory(current)).passed, true);
  assert.deepEqual(fs.readFileSync(path.join(current.root, filename)), before);
  write(current.root, filename, JSON.stringify([...versions, versions.find(record => record.version === "profile-v1")]));
  assert.throws(() => Check.sourceRef(current.root, selected), /exactly one selected record/);
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "version-evidence-invalid"));
  write(current.root, filename, JSON.stringify(versions.filter(record => record.version !== "profile-v1")));
  assert.throws(() => Check.sourceRef(current.root, selected), /exactly one selected record/);
  assert.throws(() => Check.sourceRef(current.root, { ...selected, select: {} }), /explicit strings/);
  assert.throws(() => Check.sourceRef(current.root, { ...selected, select: { version: null } }), /explicit strings/);
  assert.throws(() => Check.sourceRef(current.root, { ...selected, kind: "literal", value: "profile-v2" }), /JSON array/);
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
});

test("owned native helpers have explicit evidence without claiming an upstream source identity", async t => {
  const current = fixture(t), source = "src/modules/fixture/overlays/helper.m", catalog = "scripts/helpers.json";
  write(current.root, source, "owned helper source\n");
  write(current.root, catalog, JSON.stringify([{ version: "helper-v2" }]));
  const helper = { id: "owned-helper", kind: "owned-native-helper", version: "helper-v2",
    versionRefs: [{ kind: "json", path: catalog, select: { version: "helper-v2" }, property: "version" }],
    ownedFiles: [{ path: source, sha256: sha("owned helper source\n") }],
    buildEntries: [source], tests: ["tests/focused.test.js"], operations: [] };
  current.inventory.recipes.push(helper);
  assert.equal((await Check.checkInventory(current)).passed, true);
  const originalRecipe = structuredClone(helper);
  helper.operations = [{ kind: "call", module: current.applyFile, export: "apply", arguments: ["$stage"] }];
  assert.throws(() => Check.validateInventory(current.inventory), /cannot declare upstream Git operations/);
  Object.assign(helper, originalRecipe); helper.project = "fixture";
  assert.throws(() => Check.validateInventory(current.inventory), /cannot declare upstream Git operations/);
  delete helper.project; helper.kind = "source-overlay";
  assert.throws(() => Check.validateInventory(current.inventory), /invalid source adaptation recipe/);
  helper.kind = "owned-native-helper"; helper.versionRefs = [];
  assert.throws(() => Check.validateInventory(current.inventory), /exact owned\/version evidence/);
  assert.equal(git(current.source, "rev-parse", "HEAD"), current.revision);
});

test("a missing checkout is reported separately and remains uninitialized", async t => {
  const current = fixture(t);
  fs.rmSync(path.join(current.source, ".git"), { recursive: true });
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true);
  assert.ok(report.warnings.some(issue => issue.code === "checkout-uninitialized"));
  assert.match(report.optionalSourceInstruction, /node scripts\/init-submodules\.cjs --all/);
  assert.equal(fs.existsSync(path.join(current.source, ".git")), false);
});

test("optional source evidence has an explicit setup instruction while missing owned evidence still fails", async t => {
  const current = fixture(t), relative = "src/external/fixture";
  current.inventory.projects[0].pinRefs.push({ kind: "literal", path: relative + "/pin.txt", value: current.revision });
  current.inventory.recipes[0].sourceEvidence = [relative + "/engine.c"];
  fs.renameSync(current.source, current.source + "-uninitialized");
  const report = await Check.checkInventory(current);
  assert.equal(report.passed, true);
  assert.match(report.optionalSourceInstruction, /node scripts\/init-submodules\.cjs --all/);
  assert.equal(report.warnings.filter(issue => issue.code === "optional-source-evidence-unavailable").length, 2);
  current.inventory.recipes[0].sourceEvidence.push("src/modules/fixture/missing-owned.c");
  assert.ok((await Check.checkInventory(current)).errors.some(issue => issue.code === "source-evidence-missing" && issue.path === "src/modules/fixture/missing-owned.c"));
});

test("an absent optional candidate checkout names the maintainer command before creating staging storage", async t => {
  const current = fixture(t), workDir = path.join(current.root, "candidate-export");
  fs.renameSync(current.source, current.source + "-uninitialized");
  await assert.rejects(Check.checkCandidate({ ...current, projectId: "fixture", revision: current.revision, workDir }),
    /node scripts\/init-submodules\.cjs --all/);
  assert.equal(fs.existsSync(workDir), false);
});

test("candidate check applies only to an owned copy and records original/adapted identities", async t => {
  const current = fixture(t), workDir = path.join(current.root, "candidate-export");
  const original = fs.readFileSync(path.join(current.source, "engine.c"));
  const indexBefore = git(current.root, "ls-files", "--stage");
  const report = await Check.checkCandidate({ ...current, projectId: "fixture", workDir, recipeId: "fixture-overlay" });
  assert.equal(report.passed, true);
  assert.equal(report.fetched, false);
  assert.equal(report.readyForDistribution, false);
  assert.equal(report.upstreamCheckoutUnchanged, true);
  assert.equal(report.results[0].overlayApplyChecked, true);
  const changed = report.results[0].changedFiles.find(file => file.path === "engine.c");
  assert.equal(changed.originalSha256, sha(original));
  assert.equal(changed.adaptedSha256, sha("reviewed source\nowned adaptation\n"));
  assert.equal(report.results[0].changedFiles.find(file => file.path === "helper.c").originalSha256, null);
  assert.deepEqual(fs.readFileSync(path.join(current.source, "engine.c")), original);
  assert.equal(fs.existsSync(path.join(current.source, "helper.c")), false);
  assert.equal(git(current.root, "ls-files", "--stage"), indexBefore);
  assert.equal(fs.existsSync(path.join(workDir, "candidate-report.json")), true);
});

test("candidate source changes are conflicts; original hash guards are never relaxed", async t => {
  const current = fixture(t);
  write(current.source, "engine.c", "upstream changed this source\n"); git(current.source, "add", "engine.c"); git(current.source, "commit", "-qm", "Candidate source");
  const revision = git(current.source, "rev-parse", "HEAD"), workDir = path.join(current.root, ".local/conflict");
  const report = await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir });
  assert.equal(report.passed, false);
  assert.match(report.results[0].error, /Original source checksum differs/);
  assert.equal(report.upstreamCheckoutUnchanged, true);
  assert.equal(git(current.source, "rev-parse", "HEAD"), revision);
  assert.equal(fs.existsSync(path.join(workDir, "fixture-overlay/source/helper.c")), false);
  assert.equal(current.inventory.projects[0].revision, current.revision);
});

test("candidate check refuses changed owned adaptation bytes before invocation", async t => {
  const current = fixture(t);
  fs.appendFileSync(path.join(current.root, current.applyFile), "// changed after review\n");
  await assert.rejects(Check.checkCandidate({ ...current, projectId: "fixture", workDir: path.join(current.root, ".local/changed-owned") }), /Owned adaptation changed/);
  assert.equal(fs.existsSync(path.join(current.source, "helper.c")), false);
});

test("candidate check rejects an incorrect adapted hash even when the apply routine succeeds", async t => {
  const current = fixture(t);
  current.inventory.recipes[0].reviewedAdaptedFiles["engine.c"] = "f".repeat(64);
  const report = await Check.checkCandidate({ ...current, projectId: "fixture", workDir: path.join(current.root, ".local/adapted-conflict") });
  assert.equal(report.passed, false);
  assert.match(report.results[0].error, /Adapted source checksum differs/);
  assert.equal(report.upstreamCheckoutUnchanged, true);
});

test("candidate check protects a new upstream file from an owned helper name collision", async t => {
  const current = fixture(t);
  write(current.source, "helper.c", "new upstream helper\n"); git(current.source, "add", "helper.c"); git(current.source, "commit", "-qm", "Upstream added a helper");
  const revision = git(current.source, "rev-parse", "HEAD"), workDir = path.join(current.root, ".local/helper-conflict");
  const report = await Check.checkCandidate({ ...current, revision, projectId: "fixture", workDir });
  assert.equal(report.passed, false);
  assert.match(report.results[0].error, /Original source checksum differs: helper.c/);
  assert.equal(fs.readFileSync(path.join(workDir, "fixture-overlay/source/helper.c"), "utf8"), "new upstream helper\n");
});

test("candidate storage rejects vendor paths, aliases and nonempty destinations", t => {
  const current = fixture(t);
  assert.throws(() => Check.ensureOwnedWork(current.root, current.inventory, path.join(current.source, "build")), /separate/);
  const alias = path.join(current.root, "alias"); fs.symlinkSync(current.source, alias);
  assert.throws(() => Check.ensureOwnedWork(current.root, current.inventory, path.join(alias, "build")), /separate/);
  assert.throws(() => Check.ensureOwnedWork(current.root, current.inventory, path.join(current.root, ".git/candidate")), /Git metadata/);
  assert.throws(() => Check.ensureOwnedWork(current.root, current.inventory, current.root), /separate|empty/);
  assert.throws(() => Check.ensureOwnedWork(current.root, current.inventory, ".local/candidate"), /absolute/);
});

test("Git source symlinks cannot escape bounded owned staging", async t => {
  const current = fixture(t);
  fs.symlinkSync("/outside-owned-storage", path.join(current.source, "escape")); git(current.source, "add", "escape"); git(current.source, "commit", "-qm", "Escaping source alias");
  const revision = git(current.source, "rev-parse", "HEAD");
  await assert.rejects(Check.materializeGitTree({ source: current.source, revision, destination: path.join(current.root, ".local/stage"),
    root: current.root, project: current.inventory.projects[0], projects: current.inventory.projects }), /symlink escapes/);
  assert.equal(fs.readlinkSync(path.join(current.source, "escape")), "/outside-owned-storage");
});

test("full immutable commits and explicit network arguments are required", () => {
  assert.throws(() => Check.validateInventory({ schemaVersion: 1, projects: [{ id: "moving", repository: "https://example.invalid/repo", revision: "main" }], recipes: [] }), /identity/);
  assert.throws(() => Check.options(["--fetch"]), /explicit candidate/);
  assert.throws(() => Check.options(["--source", "/local/checkout"]), /require --candidate/);
  assert.throws(() => Check.relativePath("../external"), /Unsafe/);
  assert.equal(Check.normalizedOrigin("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
});

test("checked-in inventory validates retained source records and explicit recipes", async () => {
  const inventory = require("../scripts/upstream-overlays.json");
  Check.validateInventory(inventory);
  const links = await Check.indexLinks(Check.ROOT);
  for (const project of inventory.projects) {
    const revision = project.revision || links.get(project.path);
    if (!project.parent) assert.match(revision, /^[a-f0-9]{40}$/, project.id);
    for (const ref of project.pinRefs || []) assert.equal(Check.sourceRef(Check.ROOT, ref), revision, project.id);
  }
  for (const recipe of inventory.recipes) {
    for (const file of recipe.ownedFiles || []) assert.equal(sha(fs.readFileSync(path.join(Check.ROOT,file.path))),file.sha256,file.path);
    for (const file of [...recipe.tests || [], ...recipe.buildEntries || []]) assert.equal(fs.existsSync(path.join(Check.ROOT,file)),true,file);
  }
});
