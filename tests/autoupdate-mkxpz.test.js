const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Updater = require("../scripts/autoupdate-mkxpz");
const All = require("../scripts/autoupdate-all");
const Core = require("../src/modules/rgss/runtime/mkxpz-runtime-manager");
const { reviewedBinaryTree } = require("../scripts/stage-native-runtimes.cjs");

const quiet = { info() {}, warn() {} };
const includedSha = "a".repeat(40), candidateSha = "b".repeat(40);
const includedVersion = `2026-01-12T18-22-32Z_${includedSha}`;
const candidateVersion = `2026-10-08T12-13-14Z_${candidateSha}`;
const creatorBytes = Buffer.from("Unmodified publisher executable fixture");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function actions(version, extra = {}) {
  const [stamp, sha] = version.split("_");
  return { version, date: stamp.replace(/T(\d+)-(\d+)-(\d+)Z$/, "T$1:$2:$3Z"), sha,
    runId: 120, artifactId: 340, name: "macos-universal", ...extra };
}

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mkxpz-candidate-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repo");
  fs.mkdirSync(path.join(repositoryRoot, "src/external/vendor"), { recursive: true });
  const binary = { schemaVersion: 1, version: includedVersion, appName: "Z-universal.app", upstreamRevision: includedSha,
    sourceUrl: `https://github.com/mkxp-z/mkxp-z/tree/${includedSha}`, binaryOrigin: "Existing reviewed pin",
    executableSha256: "c".repeat(64), treeSha256: "d".repeat(64) };
  const pinPath = path.join(repositoryRoot, "src/modules/rgss/runtime/bundled-binary.json");
  const oldPayload = path.join(repositoryRoot, "src/resources/native-runtimes/mkxpz/previous/files/old-native");
  const oldLegacy = path.join(repositoryRoot, "src/modules/rgss/resources/mkxpz/previous/original");
  for (const [file, content] of [[pinPath, JSON.stringify(binary)], [oldPayload, "Existing sealed payload"],
      [oldLegacy, "Existing legacy input retained"], [path.join(repositoryRoot, "src/external/vendor/source"), "Read-only source"]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const publicFiles = [pinPath, oldPayload, oldLegacy, path.join(repositoryRoot, "src/external/vendor/source")];
  const originals = publicFiles.map(file => fs.readFileSync(file));
  const calls = { auth: 0, latest: 0, all: 0, installs: [] };
  const catalog = { versions: [candidateVersion], entries: [actions(candidateVersion)] };
  const core = {
    BUNDLED_VERSION: includedVersion, BUNDLED_APP_NAME: binary.appName, normalizeVersion: Core.normalizeVersion,
    async canUseGh() { calls.auth++; return true; },
    async fetchLatestAvailableVersions() { calls.latest++; return catalog; },
    async fetchAvailableVersions() { calls.all++; return catalog; },
    async installFromGh({ userDataDir, entry }) {
      calls.installs.push(entry);
      const installDir = path.join(userDataDir, "runtimes/mkxpz", entry.version);
      const appPath = path.join(installDir, binary.appName);
      fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
      fs.writeFileSync(path.join(appPath, "Contents/MacOS/Z-universal"), creatorBytes, { mode: 0o755 });
      fs.writeFileSync(path.join(appPath, "LICENSE"), "Publisher license\n", { mode: 0o644 });
      fs.writeFileSync(path.join(installDir, ".maclauncher-mkxpz.json"), JSON.stringify({
        version: entry.version, source: "GitHub Actions", runId: entry.runId, artifactId: entry.artifactId,
        artifactName: entry.name, sha: entry.sha, date: entry.date }));
      return { version: entry.version, installDir, appPath, source: "GitHub Actions" };
    }
  };
  const outputRoot = path.join(repositoryRoot, ".local/runtime-distribution/mkxpz-candidates");
  const dependencies = { core, binary, repositoryRoot };
  const fetch = options => Updater.fetchMkxpzCandidate({ logger: quiet, outputRoot, ...options }, dependencies);
  const unchanged = () => publicFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originals[index]));
  return { temp, repositoryRoot, outputRoot, dependencies, binary, core, catalog, calls, fetch, unchanged };
}

test("MKXP latest matching Included is a no-op without creating candidate output or changing old payloads", async t => {
  const f = fixture(t);
  f.catalog.versions = [includedVersion]; f.catalog.entries = [actions(includedVersion)];
  const result = await f.fetch();
  assert.equal(result.reason, "already-included"); assert.equal(result.updated, false);
  assert.equal(f.calls.installs.length, 0); assert.equal(fs.existsSync(f.outputRoot), false);
  f.unchanged();
});

test("explicit Included selection requires no GitHub authentication or network", async t => {
  const f = fixture(t); f.core.canUseGh = () => assert.fail("No authentication for Included no-op");
  const result = await Updater.updateMkxpzEmbedded({ logger: quiet, outputRoot: f.outputRoot, version: includedVersion }, f.dependencies);
  assert.equal(result.downloaded, false); assert.equal(result.reason, "already-included");
  assert.equal(fs.existsSync(f.outputRoot), false); f.unchanged();
});

test("MKXP candidate keeps one publisher app, exact Actions identity and shared tree hash without publishing", async t => {
  const f = fixture(t), result = await f.fetch();
  assert.equal(result.version, candidateVersion); assert.equal(result.updated, false); assert.equal(result.downloaded, true);
  assert.equal(f.calls.installs.length, 1);
  assert.deepEqual(result.candidate.actions, actions(candidateVersion));
  assert.equal(result.candidate.executableSha256, digest(creatorBytes));
  assert.equal(result.candidate.treeSha256, reviewedBinaryTree(result.appPath));
  assert.equal(result.candidate.proposedPin.upstreamRevision, candidateSha);
  assert.equal(result.candidate.proposedPin.executableSha256, digest(creatorBytes));
  assert.equal(result.candidate.proposedPin.treeSha256, result.candidate.treeSha256);
  assert.equal(result.candidate.status, "pending-review");
  assert.equal(result.candidate.appRelativePath, `runtimes/mkxpz/${candidateVersion}/Z-universal.app`);
  assert.equal(JSON.stringify(result.candidate).includes(f.temp), false, "review metadata uses logical paths");
  assert.deepEqual(fs.readdirSync(path.join(f.outputRoot, "runtimes/mkxpz")), [candidateVersion]);
  assert.deepEqual(fs.readFileSync(path.join(result.appPath, "Contents/MacOS/Z-universal")), creatorBytes);
  f.unchanged();
});

test("explicit MKXP version downloads that exact retained entry instead of the newest entry", async t => {
  const f = fixture(t), olderVersion = `2026-02-03T04-05-06Z_${"e".repeat(40)}`;
  f.catalog.versions.push(olderVersion); f.catalog.entries.push(actions(olderVersion, { runId: 121, artifactId: 341 }));
  const result = await f.fetch({ version: olderVersion });
  assert.equal(f.calls.latest, 0); assert.equal(f.calls.all, 1);
  assert.equal(f.calls.installs[0].version, olderVersion); assert.equal(result.version, olderVersion); f.unchanged();
});

test("MKXP catalog SHA/date/version and Actions IDs must agree before a download begins", async t => {
  for (const extra of [{ sha: "f".repeat(40) }, { date: "2026-10-07T12:13:14Z" }, { runId: 0 }, { artifactId: "340" }]) {
    const f = fixture(t); f.catalog.entries = [actions(candidateVersion, extra)];
    await assert.rejects(f.fetch(), /catalog entry.*exact version/);
    assert.equal(f.calls.installs.length, 0); assert.equal(fs.existsSync(f.outputRoot), false); f.unchanged();
  }
});

test("mismatched MKXP download descriptor is retained as a failed candidate and cannot rewrite pins", async t => {
  const f = fixture(t), download = f.core.installFromGh;
  f.core.installFromGh = async args => ({ ...await download(args), version: includedVersion });
  await assert.rejects(f.fetch(), /descriptor.*selected candidate/);
  const executable = path.join(f.outputRoot, "runtimes/mkxpz", candidateVersion, "Z-universal.app/Contents/MacOS/Z-universal");
  assert.deepEqual(fs.readFileSync(executable), creatorBytes);
  const failed = fs.readdirSync(path.join(f.outputRoot, "failures")); assert.equal(failed.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.outputRoot, "failures", failed[0])));
  assert.equal(receipt.status, "failed"); assert.deepEqual(receipt.actions, actions(candidateVersion));
  assert.equal(fs.existsSync(path.join(f.outputRoot, "reviews", `${candidateVersion}.json`)), false); f.unchanged();
});

test("MKXP installation metadata from another artifact fails without deleting the returned app", async t => {
  const f = fixture(t), download = f.core.installFromGh;
  f.core.installFromGh = async args => {
    const installed = await download(args), file = path.join(installed.installDir, ".maclauncher-mkxpz.json");
    const record = JSON.parse(fs.readFileSync(file)); record.artifactId++; fs.writeFileSync(file, JSON.stringify(record));
    return installed;
  };
  await assert.rejects(f.fetch(), /installation record.*selected Actions artifact/);
  assert.equal(fs.existsSync(path.join(f.outputRoot, "runtimes/mkxpz", candidateVersion, "Z-universal.app")), true);
  assert.equal(f.calls.installs.length, 1); f.unchanged();
});

test("verified explicit MKXP candidate is rehashed and reused offline with no second app or receipt", async t => {
  const f = fixture(t), first = await f.fetch();
  const receiptBytes = fs.readFileSync(first.receiptPath);
  f.core.canUseGh = () => assert.fail("Verified explicit candidate should work offline");
  const second = await f.fetch({ version: candidateVersion });
  assert.equal(second.reused, true); assert.equal(second.downloaded, false);
  assert.equal(second.appPath, first.appPath); assert.equal(f.calls.installs.length, 1);
  assert.deepEqual(fs.readFileSync(first.receiptPath), receiptBytes); f.unchanged();
});

test("changed MKXP candidate resources fail reuse and retain both changed bytes and original review", async t => {
  const f = fixture(t), first = await f.fetch(), file = path.join(first.appPath, "LICENSE");
  const receiptBytes = fs.readFileSync(first.receiptPath);
  fs.appendFileSync(file, "Changed resource\n");
  await assert.rejects(f.fetch({ version: candidateVersion }), /candidate bytes or review pin changed/);
  assert.match(fs.readFileSync(file, "utf8"), /Changed resource/);
  assert.deepEqual(fs.readFileSync(first.receiptPath), receiptBytes); assert.equal(f.calls.installs.length, 1); f.unchanged();
});

test("MKXP reuse rejects a proposed source pin edited to another repository", async t => {
  const f = fixture(t), first = await f.fetch(), receipt = JSON.parse(fs.readFileSync(first.receiptPath));
  receipt.proposedPin.sourceUrl = "https://github.com/example/incorrect/tree/" + candidateSha;
  fs.writeFileSync(first.receiptPath, JSON.stringify(receipt));
  await assert.rejects(f.fetch({ version: candidateVersion }), /candidate bytes or review pin changed/);
  assert.equal(f.calls.installs.length, 1); f.unchanged();
});

test("MKXP output rejects public source, checkout aliases and private links back into source", async t => {
  const f = fixture(t), alias = path.join(f.temp, "repo-alias");
  fs.symlinkSync(f.repositoryRoot, alias, "dir");
  fs.mkdirSync(path.join(f.repositoryRoot, ".local"));
  const escape = path.join(f.repositoryRoot, ".local/source-alias");
  fs.symlinkSync(path.join(f.repositoryRoot, "src"), escape, "dir");
  for (const outputRoot of [path.join(f.repositoryRoot, "src/external/vendor/new"),
      path.join(alias, "src/resources/new"), path.join(escape, "new"), f.repositoryRoot, f.temp]) {
    await assert.rejects(f.fetch({ outputRoot }), /outside public repository source|public or external source/);
  }
  assert.equal(f.calls.auth, 0); assert.equal(f.calls.installs.length, 0);
  assert.equal(Updater.resolveOutput(path.join(alias, ".local/new-candidate"), f.repositoryRoot), path.join(f.repositoryRoot, ".local/new-candidate"));
  f.unchanged();
});

test("MKXP output cannot claim an unrelated directory or an externally symlinked source checkout", async t => {
  const f = fixture(t), unrelated = path.join(f.temp, "unrelated");
  fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, "keep"), "Keep unrelated bytes");
  await assert.rejects(f.fetch({ outputRoot: unrelated }), /empty directory|existing MKXP-Z candidate/);
  const outsideSource = path.join(f.temp, "upstream-source"); fs.mkdirSync(outsideSource);
  fs.symlinkSync(outsideSource, path.join(f.repositoryRoot, "src/external/alias-checkout"), "dir");
  await assert.rejects(f.fetch({ outputRoot: path.join(outsideSource, "candidate") }), /public or external source/);
  assert.equal(fs.readFileSync(path.join(unrelated, "keep"), "utf8"), "Keep unrelated bytes");
  assert.equal(f.calls.auth, 0); f.unchanged();
});

test("MKXP internal candidate directory links are rejected before installing into source", async t => {
  const f = fixture(t); fs.mkdirSync(f.outputRoot, { recursive: true });
  fs.writeFileSync(path.join(f.outputRoot, ".maclauncher-mkxpz-candidates.json"), JSON.stringify({ format: "maclauncher-mkxpz-candidates-v1" }));
  fs.symlinkSync(path.join(f.repositoryRoot, "src"), path.join(f.outputRoot, "runtimes"), "dir");
  await assert.rejects(f.fetch(), /symlink escapes/);
  assert.equal(f.calls.installs.length, 0); f.unchanged();
});

test("MKXP incomplete prior candidate is preserved and never redownloaded over it", async t => {
  const f = fixture(t); fs.mkdirSync(f.outputRoot, { recursive: true });
  fs.writeFileSync(path.join(f.outputRoot, ".maclauncher-mkxpz-candidates.json"), JSON.stringify({ format: "maclauncher-mkxpz-candidates-v1" }));
  const existing = path.join(f.outputRoot, "runtimes/mkxpz", candidateVersion); fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "incomplete-download"), "Retain partial candidate");
  await assert.rejects(f.fetch(), /ENOENT/);
  assert.equal(f.calls.installs.length, 0);
  assert.equal(fs.readFileSync(path.join(existing, "incomplete-download"), "utf8"), "Retain partial candidate"); f.unchanged();
});

test("simultaneous MKXP updater calls cannot download over the same candidate", async t => {
  const f = fixture(t), download = f.core.installFromGh;
  let entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  f.core.installFromGh = async args => { entered(); await gate; return download(args); };
  const first = f.fetch();
  await waiting;
  await assert.rejects(f.fetch(), /transfer is active or interrupted/);
  assert.equal(fs.readdirSync(path.join(f.outputRoot, "transfers")).length, 1);
  finish();
  const result = await first;
  assert.equal(result.downloaded, true); assert.equal(f.calls.installs.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.outputRoot, "transfers")), []); f.unchanged();
});

test("autoupdate-all uses candidate wording and preserves the Included no-op", async t => {
  const f = fixture(t), messages = [];
  const result = await All.updateAllEmbedded({ version: includedVersion, outputRoot: f.outputRoot,
    logger: { info: value => messages.push(value) } }, f.dependencies);
  assert.equal(result.mkxpz.updated, false); assert.equal(result.mkxpz.reason, "already-included");
  assert.match(messages.at(-1), /maintainer candidates checked.*pins and payloads stay unchanged/);
  assert.equal(f.calls.auth, 0); f.unchanged();
});

test("updater import and help perform no command execution or network requests", () => {
  const root = path.resolve(__dirname, "..");
  const guard = `const fail=()=>{throw Error('Unexpected command/network on import/help')};
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])require('node:child_process')[name]=fail;
    for(const name of ['node:http','node:https']){require(name).request=fail;require(name).get=fail;}
    global.fetch=fail;`;
  for (const code of ["require('./scripts/autoupdate-mkxpz');require('./scripts/autoupdate-all');",
      "require('./scripts/autoupdate-mkxpz').main(['--help']);", "require('./scripts/autoupdate-all').main(['--help']);"]) {
    const result = spawnSync(process.execPath, ["-e", guard + code], { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    if (code.includes("main")) assert.match(result.stdout, /candidate.*review/);
    else assert.equal(result.stdout, "");
  }
});
