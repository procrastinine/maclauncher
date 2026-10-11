const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { auditRepository } = require("../scripts/audit-public-repo.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  const write = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(".gitignore", ".local/\nnode_modules/\ndist/\nsrc/resources/native-runtimes/\n");
  return { root, write, git: (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }) };
}
const personal = () => ["", "Users", "synthetic-person", "private-project", "build-output"].join("/");
const token = () => "gh" + "p_" + "a".repeat(36);
function commitFixture(f, message, name = "Fixture Author", email = "fixture@example.invalid") {
  f.git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "--message", message);
}

test("audit includes cleaned staged blobs and intended source while redacting every matched value", t => {
  const f = fixture(t), privatePath = personal(), secret = token();
  f.write("src/config.json", JSON.stringify({ access_token: secret, buildPath: privatePath }));
  f.git("add", "src/config.json");
  f.write("src/config.json", JSON.stringify({ access_token: "REDACTED" }));
  f.write("docs/source.md", "Build path: " + privatePath + "\n");
  const result = auditRepository({ root: f.root });
  assert.ok(result.findings.some(x => x.scope === "index" && x.category === "credential_token"));
  assert.ok(result.findings.some(x => x.scope === "index" && x.category === "personal_home_path"));
  assert.ok(result.findings.some(x => x.file === "docs/source.md" && x.line === 1));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(privatePath), false);
  assert.equal(serialized.includes(f.root), false); assert.equal(result.stats.historyScanned, false);
});

test("ignored private fixtures/config and external gitlink interiors are not read", t => {
  const f = fixture(t), secret = token();
  for (const file of [".local/localconfig.json", ".local/games/original.npa", "node_modules/private.js", "dist/session.json", "src/external/pinned/private.txt"])
    f.write(file, secret + personal());
  f.git("update-index", "--add", "--cacheinfo", "160000," + "a".repeat(40) + ",src/external/pinned");
  const before = fs.readFileSync(path.join(f.root, ".local/localconfig.json"));
  const result = auditRepository({ root: f.root });
  assert.equal(result.status, "clear"); assert.equal(result.stats.gitlinks, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".local/localconfig.json")), before);
});

test("declared packaged resources include ignored manifests and native binary UTF16 strings", t => {
  const f = fixture(t), privatePath = personal();
  f.write("package.json", JSON.stringify({ build: { extraResources: [{ from: "src/resources", to: "." }] } }));
  f.write("src/resources/native-runtimes/engine/manifest.json", JSON.stringify({ provenance: { logPath: privatePath } }));
  f.write("src/resources/native-runtimes/engine/bin/runner", Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(privatePath + "\0", "utf16le")]));
  const result = auditRepository({ root: f.root });
  assert.ok(result.findings.some(x => x.file.endsWith("manifest.json") && x.scope.includes("packaged")));
  assert.ok(result.findings.some(x => x.file.endsWith("runner") && x.line === null && x.category === "personal_home_path"));
  assert.ok(result.stats.binaryFiles > 0); assert.ok(result.stats.packagedFiles >= 2);
  assert.equal(JSON.stringify(result).includes(privatePath), false);
});

test("temporary compiler paths distinguish this machine from upstream build context without printing values", t => {
  const f = fixture(t);
  const temporaryRoot = path.join(os.tmpdir(), "maclauncher-audit-private-build");
  t.mock.method(os, "tmpdir", () => temporaryRoot);
  const local = path.join(temporaryRoot, "source", "SDL.c");
  const vendor = ["", "private", "var", "folders", "vendor", "synthetic-build", "T", "source", "Python.c"].join("/");
  f.write("src/compiler.bin", Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from(local + "\0"), Buffer.from(vendor + "\0", "utf16le")]));
  const result = auditRepository({ root: f.root, inspectPackages: false });
  assert.ok(result.findings.some(x => x.category === "temporary_build_path" && x.origin === "current-machine" && x.line === null));
  assert.ok(result.findings.some(x => x.category === "temporary_build_path" && x.origin === "other-machine-or-example"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(local), false);
  assert.equal(serialized.includes(vendor), false);
});

test("private MacLauncher build records remain flagged after the developer home changes", t => {
  const f = fixture(t);
  const previous = ["", "Users", "previous-private-person", "work", "maclauncher", ".local", "example_repos", "decrypter", "obj", "tool.pdb"].join("/");
  const upstream = ["", "Users", "buildagent", "work", "1", "s", "src", "runtime.c"].join("/");
  const neutral = ["", "Users", "example-user", "maclauncher", ".local", "example_repos", "tool.c"].join("/");
  f.write("src/tool.bin", Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(previous + "\0"),
    Buffer.from(previous + "\0", "utf16le"), Buffer.from(upstream + "\0")]));
  f.write("docs/example.md", neutral + "\n/Users/<user>/maclauncher/.local/example_repos/tool.c\n");
  const result = auditRepository({ root: f.root, inspectPackages: false });
  const privateBuilds = result.findings.filter(x => x.category === "private_maclauncher_build_path");
  assert.equal(privateBuilds.reduce((sum, row) => sum + row.count, 0), 2);
  assert.ok(privateBuilds.every(x => x.file === "src/tool.bin" && x.line === null));
  assert.ok(result.findings.some(x => x.category === "personal_home_path" && x.origin === "other-machine-or-example"));
  for (const value of [previous, upstream, neutral]) assert.equal(JSON.stringify(result).includes(value), false);
});

test("temporary root symlink aliases identify the real compiler path without classifying another build as local", t => {
  const f = fixture(t);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-audit-build-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const alias = path.join(f.root, "maclauncher-temporary-alias");
  fs.symlinkSync(temporary, alias, "dir");
  t.mock.method(os, "tmpdir", () => alias);
  f.write("src/compiler.txt", path.join(fs.realpathSync(temporary), "source", "SDL.c") + "\n");
  const result = auditRepository({ root: f.root, inspectPackages: false });
  assert.ok(result.findings.some(x => x.category === "temporary_build_path" && x.origin === "current-machine"));
  assert.equal(result.findings.some(x => x.category === "temporary_build_path" && x.origin === "other-machine-or-example"), false);
  assert.equal(JSON.stringify(result).includes(temporary), false);
});

test("custom temporary directories outside standard OS locations are detected with exact path boundaries", t => {
  const f = fixture(t), temporary = ["", "workspace", "build-temp"].join("/");
  t.mock.method(os, "tmpdir", () => temporary);
  f.write("src/compiler.bin", Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from(temporary + "/source/native.c\0", "utf16le")]));
  f.write("src/unrelated.txt", temporary + "-other/source/native.c\n");
  const result = auditRepository({ root: f.root, inspectPackages: false });
  assert.ok(result.findings.some(x => x.category === "temporary_build_path" && x.origin === "current-machine" && x.file === "src/compiler.bin"));
  assert.equal(result.findings.some(x => x.file === "src/unrelated.txt"), false);
  assert.equal(JSON.stringify(result).includes(temporary), false);
});

test("bounded reads report incomplete scope rather than a clean audit", t => {
  const f = fixture(t); f.write("src/large.bin", Buffer.alloc(1024));
  const result = auditRepository({ root: f.root, maximumFileBytes: 64 });
  assert.equal(result.status, "review"); assert.equal(result.stats.scannedBytes < 1024, true);
  assert.ok(result.findings.some(x => x.category === "scan_incomplete_bytes"));
});

test("packaged-resource include/exclude filters avoid inspecting excluded private files", t => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ build: { files: ["package.json"], extraResources: [{ from: "payload", filter: ["**/*.txt", "!excluded/**"] }] } }));
  f.write("payload/public.txt", "portable runtime notice");
  f.write("payload/excluded/private.txt", token() + personal());
  f.write("payload/omitted.json", token());
  const result = auditRepository({ root: f.root });
  assert.equal(result.status, "clear"); assert.equal(result.stats.packagedResourceFiles, 1);
});

test("package review honors ordered glob overrides, braces and dotfiles from Electron Builder", t => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ build: { files: ["package.json"], extraResources: [{ from: "payload",
    filter: ["{public,excluded}/**", "!excluded/**", "excluded/restored.txt", "!**/.env*"] }] } }));
  f.write("payload/public/notice.txt", "portable runtime notice");
  f.write("payload/public/.env.local", token());
  f.write("payload/excluded/private.txt", token());
  f.write("payload/excluded/restored.txt", "restored public notice");
  const result = auditRepository({ root: f.root });
  assert.equal(result.status, "clear"); assert.equal(result.stats.packagedResourceFiles, 2);
});

test("ignored files selected as application payloads are scanned and excluded native roots stay private", t => {
  const f = fixture(t), secret = token();
  f.write(".gitignore", ".local/\nsrc/hidden/\nsrc/resources/native-runtimes/\n");
  f.write("package.json", JSON.stringify({ build: { files: ["package.json", "src/hidden/**"], extraResources: [
    { from: "src/resources", filter: ["public/**"] }
  ] } }));
  f.write("src/hidden/selected.json", JSON.stringify({ access_token: secret }));
  f.write("src/resources/public/notice.txt", "public resource notice");
  f.write("src/resources/native-runtimes/private.json", secret + personal());
  const result = auditRepository({ root: f.root });
  assert.ok(result.findings.some(x => x.file === "src/hidden/selected.json" && x.scope === "packaged-app" && x.category === "credential_token"));
  assert.equal(result.findings.some(x => x.file.includes("native-runtimes")), false);
  assert.equal(result.stats.packagedResourceFiles, 1);
});

test("selected external resources are inspected while unselected vendor interiors remain outside scope", t => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ build: { files: ["package.json"], extraResources: [
    { from: "src/external", filter: ["plugin/export.js"] }
  ] } }));
  f.write("src/external/plugin/export.js", token());
  f.write("src/external/plugin/private.txt", personal());
  const result = auditRepository({ root: f.root });
  assert.ok(result.findings.some(x => x.file === "src/external/plugin/export.js" && x.category === "credential_token"));
  assert.equal(result.findings.some(x => x.file.endsWith("private.txt")), false);
  assert.equal(result.stats.packagedExternalFiles, 1);
});

test("generated application output is public payload and explicit resource dependencies are inspected", t => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ build: { files: ["package.json", "dist/renderer/**"], extraResources: [
    { from: "payload", filter: ["**/*"] }
  ] } }));
  f.write("dist/renderer/index.html", "generated public application");
  f.write("payload/runtime/node_modules/explicit-dependency/config.json", token());
  f.write("payload/.git/config", "private repository metadata");
  const result = auditRepository({ root: f.root });
  assert.equal(result.findings.some(x => x.category === "private_workspace_file" && x.file.startsWith("dist/")), false);
  assert.ok(result.findings.some(x => x.file.includes("explicit-dependency") && x.category === "credential_token"));
  assert.ok(result.findings.some(x => x.category === "package_git_metadata_selected"));
});

test("binary strings crossing read boundaries and odd UTF16 alignment remain detectable", t => {
  const f = fixture(t), secret = token(), privatePath = personal();
  f.write("src/boundary.bin", Buffer.concat([Buffer.alloc(256 * 1024 - 6, 1), Buffer.from(secret), Buffer.from([0]), Buffer.from(privatePath + "\0", "utf16le")]));
  const result = auditRepository({ root: f.root, inspectPackages: false });
  assert.ok(result.findings.some(x => x.category === "credential_token"));
  assert.ok(result.findings.some(x => x.category === "personal_home_path" && x.line === null));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("finding filenames cannot print recognized credential values", t => {
  const f = fixture(t), secret = token(), assigned = "synthetic-value-fixture";
  f.write(`src/${secret}.json`, JSON.stringify({ access_token: secret }));
  f.write(`src/password="${assigned}".json`, secret);
  const result = auditRepository({ root: f.root, inspectPackages: false });
  assert.ok(result.findings.some(x => x.category === "credential_token"));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(assigned), false);
});

test("private keys and local configuration are categorized without printing their content", t => {
  const f = fixture(t);
  const header = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
  f.write("build/localconfig.json", JSON.stringify({ password: token() }));
  f.write("build/identity.pem", header + "\nprivate bytes\n");
  const result = auditRepository({ root: f.root });
  assert.ok(result.findings.some(x => x.category === "local_configuration"));
  assert.ok(result.findings.some(x => x.category === "private_key"));
  assert.equal(JSON.stringify(result).includes(header), false);
});

test("CLI writes only an ignored redacted receipt and preserves existing local configuration", t => {
  const f = fixture(t), privatePath = personal();
  f.write("src/sample.js", privatePath); f.write(".local/localconfig.json", "keep this private config");
  const result = spawnSync(process.execPath, [require.resolve("../scripts/audit-public-repo.cjs"), "--root", f.root, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout.includes(privatePath), false);
  assert.equal(result.stderr.includes(privatePath), false);
  const receipt = path.join(f.root, ".local", "notes", "public-audit-latest.json");
  assert.ok(fs.existsSync(receipt)); assert.equal(fs.readFileSync(receipt, "utf8").includes(privatePath), false);
  assert.equal(fs.readFileSync(path.join(f.root, ".local/localconfig.json"), "utf8"), "keep this private config");
  const ignored = spawnSync("git", ["-C", f.root, "check-ignore", "-q", receipt]); assert.equal(ignored.status, 0);
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
});

test("CLI refuses tracked, symlinked or hardlinked receipts before overwriting files", t => {
  for (const variant of ["tracked", "symlink", "hardlink"]) {
    const f = fixture(t), relative = path.join(".local", "notes", "public-audit-latest.json");
    const existing = "existing private receipt";
    if (variant === "tracked") {
      f.write(relative, existing); f.git("add", "--force", relative);
    } else if (variant === "symlink") {
      f.write("outside/notes/public-audit-latest.json", existing);
      fs.symlinkSync(path.join(f.root, "outside"), path.join(f.root, ".local"), "dir");
    } else {
      f.write("outside/receipt.json", existing);
      fs.mkdirSync(path.join(f.root, ".local", "notes"), { recursive: true });
      fs.linkSync(path.join(f.root, "outside", "receipt.json"), path.join(f.root, relative));
    }
    const result = spawnSync(process.execPath, [require.resolve("../scripts/audit-public-repo.cjs"), "--root", f.root], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /receipt could not be written/);
    assert.equal(fs.readFileSync(path.join(f.root, relative), "utf8"), existing);
    assert.equal(result.stdout.includes(existing), false);
  }
});

test("CLI package-only mode excludes source findings while inspecting the selected payload", t => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ build: { files: ["package.json"], extraResources: [{ from: "payload", filter: ["notice.txt"] }] } }));
  f.write("src/private.json", token()); f.write("payload/notice.txt", "public notice");
  const result = spawnSync(process.execPath, [require.resolve("../scripts/audit-public-repo.cjs"), "--root", f.root,
    "--package-only", "--json", "--no-receipt"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.scope.publicSource, false); assert.equal(receipt.stats.packagedResourceFiles, 1);
});

test("CLI help prints usage without scanning or creating a receipt", t => {
  const f = fixture(t);
  f.write(".local/localconfig.json", "preserve local configuration");
  for (const argument of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [require.resolve("../scripts/audit-public-repo.cjs"), argument,
      "--root", path.join(f.root, "not-a-repository")], { encoding: "utf8" });
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage:/); assert.match(result.stdout, /--package-only/);
    assert.equal(fs.existsSync(path.join(f.root, ".local", "notes")), false);
    assert.equal(fs.existsSync(path.join(f.root, "not-a-repository")), false);
    assert.equal(fs.readFileSync(path.join(f.root, ".local", "localconfig.json"), "utf8"), "preserve local configuration");
  }
});

test("history scans removed first-party blobs and commit messages without exposing paths, tokens or identities", t => {
  const f = fixture(t), secret = token(), privatePath = personal();
  const privateFile = path.join(".local", "notes", "synthetic-archive.txt");
  const author = "Offline Maintainer", email = "maintainer@example.invalid";
  f.write("src/record.json", JSON.stringify({ access_token: secret, location: privatePath }));
  f.write(privateFile, privatePath);
  f.write("src/external/pinned/private.txt", secret + privatePath);
  f.git("add", ".gitignore", "src/record.json"); f.git("add", "--force", privateFile);
  f.git("update-index", "--add", "--cacheinfo", "160000," + "a".repeat(40) + ",src/external/pinned");
  commitFixture(f, "historical fixture", author, email);
  f.write("src/record.json", "portable configuration\n"); f.git("add", "src/record.json");
  f.git("rm", "--quiet", "--", privateFile);
  commitFixture(f, "fixture message includes " + privatePath, author, email);
  const result = auditRepository({ root: f.root, inspectPublicSource: false, inspectPackages: false, inspectHistory: true });
  assert.equal(result.stats.historyComplete, true); assert.equal(result.stats.historyCommitCount, 2);
  assert.equal(result.stats.historyCommitsScanned, 2); assert.equal(result.stats.historyBlobsScanned, 4);
  assert.equal(result.stats.historyGitlinksSkipped, 1);
  assert.ok(result.findings.some(x => x.scope === "history-blob" && x.category === "credential_token"));
  assert.ok(result.findings.some(x => x.scope === "history-metadata" && x.category === "personal_home_path"));
  assert.ok(result.findings.some(x => x.category === "private_workspace_file"));
  assert.equal(result.stats.historyIdentityMetadataPresent, true); assert.equal(result.stats.historyAuthorNameCount, 1);
  assert.equal(result.stats.historyAuthorEmailCount, 1); assert.equal(result.stats.historyPotentialIdentityRecords, 4);
  const serialized = JSON.stringify(result);
  for (const value of [secret, privatePath, author, email, "synthetic-archive.txt"])
    assert.equal(serialized.includes(value), false);
  assert.equal(result.findings.some(x => x.file.includes("src/external/pinned")), false);
});

test("history limits report incomplete coverage and placeholder identities remain separate from private identity markers", t => {
  const f = fixture(t);
  f.write("src/first.txt", "first fixture\n"); f.git("add", ".gitignore", "src/first.txt"); commitFixture(f, "first fixture");
  f.write("src/second.txt", "second fixture\n"); f.git("add", "src/second.txt"); commitFixture(f, "second fixture");
  const bounded = auditRepository({ root: f.root, inspectPublicSource: false, inspectPackages: false, inspectHistory: true,
    maximumHistoryCommits: 1, maximumHistoryBlobs: 1 });
  assert.equal(bounded.stats.historyComplete, false);
  assert.ok(bounded.findings.some(x => x.category === "scan_incomplete_history_commit_limit"));
  assert.ok(bounded.findings.some(x => x.category === "scan_incomplete_history_blob_limit"));
  assert.equal(bounded.stats.historyPotentialIdentityRecords, 0);
  const complete = auditRepository({ root: f.root, inspectPublicSource: false, inspectPackages: false, inspectHistory: true });
  assert.equal(complete.stats.historyComplete, true); assert.equal(complete.stats.historyIdentityMetadataPresent, true);
  assert.equal(complete.stats.historyPotentialIdentityRecords, 0); assert.equal(complete.status, "clear");
});

test("CLI history-only writes a separate private receipt and preserves refs, source and the current audit receipt", t => {
  const f = fixture(t), secret = token();
  f.write("src/first.txt", secret); f.git("add", ".gitignore", "src/first.txt"); commitFixture(f, "fixture");
  const oldReceipt = path.join(".local", "notes", "public-audit-latest.json");
  f.write(oldReceipt, "keep current audit receipt");
  const gitBefore = execFileSync("git", ["-C", f.root, "show-ref"], { encoding: "utf8" });
  const result = spawnSync(process.execPath, [require.resolve("../scripts/audit-public-repo.cjs"), "--root", f.root,
    "--history-only", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stderr, ""); assert.equal(result.stdout.includes(secret), false);
  const parsed = JSON.parse(result.stdout); assert.equal(parsed.scope.publicSource, false);
  assert.equal(parsed.scope.builderSelectedResources, false); assert.equal(parsed.stats.historyComplete, true);
  const destination = path.join(f.root, ".local", "notes", "public-history-audit-latest.json");
  assert.ok(fs.existsSync(destination)); assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.root, oldReceipt), "utf8"), "keep current audit receipt");
  assert.equal(fs.readFileSync(path.join(f.root, "src", "first.txt"), "utf8"), secret);
  assert.equal(execFileSync("git", ["-C", f.root, "show-ref"], { encoding: "utf8" }), gitBefore);
});

test("history-only audits isolated bare mirrors without requiring or creating an index", t => {
  const f = fixture(t);
  f.write("src/first.txt", token()); f.git("add", ".gitignore", "src/first.txt"); commitFixture(f, "fixture");
  const mirror = path.join(f.root, ".local", "mirror.git");
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--mirror", "--no-hardlinks", f.root, mirror], { stdio: "ignore" });
  const result = auditRepository({ root: mirror, inspectPublicSource: false, inspectPackages: false, inspectHistory: true });
  assert.equal(result.stats.historyComplete, true); assert.equal(result.stats.historyCommitsScanned, 1);
  assert.ok(result.findings.some(x => x.category === "credential_token" && x.scope === "history-blob"));
  assert.equal(fs.existsSync(path.join(mirror, "index")), false);
});
