const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Native = require("../src/modules/shared/runtime/local-native");
const Identity = require("../src/modules/shared/runtime/verified-identity");
const { holdFileTimes } = require("./helpers/held-file-times.cjs");

test("digest reuse keeps full payload policy checks and rehashes changed or uncertain identities", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, "files"), bin = path.join(payload, "nested/bin");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(bin, "empty"));
  const runner = path.join(bin, "runner"), notice = path.join(bin, "NOTICE"), dependency = path.join(root, "dependency");
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(runner, executable, { mode: 0o755 });
  fs.writeFileSync(notice, "notice", { mode: 0o644 }); fs.writeFileSync(dependency, "shared", { mode: 0o644 });
  fs.utimesSync(notice, 1700000000, 1700000000);
  const fact = file => ({ size: fs.statSync(file).size, sha256: Bundled.digest(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 });
  const dependencyFact = { ...fact(dependency), path: dependency };
  const manifest = { id: "fixture", dependencies: [{ project: "shared", release: "1", sha256: "a".repeat(64) }],
    files: [{ ...fact(runner), path: "nested/bin/runner", architectures: ["arm64"] }, { ...fact(notice), path: "nested/bin/NOTICE" }],
    aliases: { schema: 1, files: { "nested/bin/alias": "nested/bin/runner", "nested/bin/shared": { project: "shared", path: "shared" } } } };
  const tiny = path.join(payload, "nested/tiny"); fs.mkdirSync(tiny);
  for (let i = 0; i < 130; i++) {
    const file = path.join(tiny, String(i)); fs.writeFileSync(file, "tiny", { mode: 0o644 });
    manifest.files.push({ ...fact(file), path: "nested/tiny/" + i });
  }
  fs.symlinkSync("runner", path.join(bin, "alias"));
  fs.symlinkSync(path.relative(bin, dependency), path.join(bin, "shared"));
  let dependencyChecks = 0;
  const resolve = () => dependencyFact;
  resolve.verify = () => { dependencyChecks++; };
  let hashes = 0, walks = 0, architectureChecks = 0;
  const hash = crypto.createHash, readdir = fs.readdirSync, architectures = Native.readMachOArchitectures;
  t.mock.method(crypto, "createHash", (...args) => { hashes++; return hash(...args); });
  t.mock.method(fs, "readdirSync", (...args) => { walks++; return readdir(...args); });
  t.mock.method(Native, "readMachOArchitectures", (...args) => { architectureChecks++; return architectures(...args); });

  assert.equal(Bundled.verifyPayload(payload, manifest, resolve), true);
  assert.equal(hashes, 133, "a manifest larger than the old128-entry cache hashes each canonical file once");
  const firstWalks = walks, firstArchitectures = architectureChecks;
  assert.equal(Bundled.verifyPayload(payload, manifest, resolve), true);
  assert.equal(hashes, 133, "the whole unchanged working set remains reusable without LRU thrashing");
  assert.ok(walks > firstWalks, "full inventory traversal still runs, including the empty directory");
  assert.ok(architectureChecks > firstArchitectures, "CPU validation still runs");
  assert.equal(dependencyChecks, 2, "dependency verification remains live on every verification");

  const wrongHash = structuredClone(manifest); wrongHash.files[1].sha256 = "0".repeat(64);
  assert.throws(() => Bundled.verifyPayload(payload, wrongHash, resolve), /checksum/);
  const wrongCPU = structuredClone(manifest); wrongCPU.files[0].architectures = ["x86_64"];
  assert.throws(() => Bundled.verifyPayload(payload, wrongCPU, resolve), /architecture/);
  const wrongAlias = structuredClone(manifest); wrongAlias.aliases.files["nested/bin/alias"] = "nested/bin/NOTICE";
  assert.throws(() => Bundled.verifyPayload(payload, wrongAlias, resolve), /symlink/);
  fs.unlinkSync(path.join(bin, "alias")); fs.symlinkSync("NOTICE", path.join(bin, "alias"));
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /alias differs/);
  fs.unlinkSync(path.join(bin, "alias")); fs.symlinkSync("runner", path.join(bin, "alias"));
  fs.writeFileSync(path.join(bin, "empty/extra"), "extra");
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /inventory/);
  fs.unlinkSync(path.join(bin, "empty/extra"));
  fs.renameSync(notice, path.join(root, "held-notice"));
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /inventory/);
  fs.renameSync(path.join(root, "held-notice"), notice);
  resolve.verify = () => { throw Error("dependency rejected"); };
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /dependency rejected/);
  resolve.verify = () => { dependencyChecks++; };

  const oldMtime = fs.statSync(notice, { bigint: true }).mtimeNs;
  fs.writeFileSync(notice, "broken"); fs.utimesSync(notice, 1700000000, 1700000000);
  assert.equal(fs.statSync(notice, { bigint: true }).mtimeNs, oldMtime);
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /checksum/, "same-size restored-mtime tampering cannot reuse the old digest");
  fs.writeFileSync(notice, "notice");
  assert.equal(Bundled.verifyPayload(payload, manifest, resolve), true);
  const bytes = Bundled.readRegular(notice, 6);
  assert.deepEqual(bytes.bytes, Buffer.from("notice"), "the default byte-returning API is unchanged");
  const beforeNative = hashes;
  assert.equal(Native.hashFile(notice), manifest.files[1].sha256);
  assert.equal(hashes, beforeNative + 1);
  assert.equal(Native.hashFile(notice), manifest.files[1].sha256);
  assert.equal(hashes, beforeNative + 1, "local native hashing also reuses precise digest facts");
  fs.chmodSync(notice, 0o600);
  assert.throws(() => Bundled.verifyPayload(payload, manifest, resolve), /permissions/);
  fs.chmodSync(notice, 0o644);

  const coarse = path.join(root, "coarse"); fs.writeFileSync(coarse, "original");
  holdFileTimes(t, [coarse]);
  const beforeCoarse = hashes, originalDigest = Native.hashFile(coarse);
  assert.equal(Identity.fileIdentity(coarse), null);
  assert.equal(Native.hashFile(coarse), originalDigest);
  assert.equal(hashes, beforeCoarse + 4, "coarse facts require both byte-validation passes every time");
  fs.writeFileSync(coarse, "modified");
  assert.notEqual(Native.hashFile(coarse), originalDigest, "even held size, mtime and ctime do not hide changed coarse bytes");

  const cache = Identity.createVerifiedIdentityCache({ maximum: 1 });
  let identity = "before", calls = 0;
  const changing = { identity: () => identity, verify: () => { calls++; identity = "after"; return true; } };
  assert.equal(cache.verify("tool", changing), true);
  assert.equal(cache.verify("tool", changing), true);
  assert.equal(calls, 2, "a changed pre/post identity was not remembered");
  assert.equal(cache.verify("tool", changing), true); assert.equal(calls, 2);
  identity = "failed";
  assert.throws(() => cache.verify("tool", { identity: () => identity, verify: () => { throw Error("verification refused"); } }), /refused/);
  assert.equal(await cache.verify("tool", { identity: () => identity, verify: async () => { calls++; return true; } }), true);
  assert.equal(calls, 3, "a failed verification cannot authorize reuse");
  cache.verify("other", { identity: () => "other", verify: () => true });
  cache.verify("tool", { identity: () => identity, verify: () => { calls++; return true; } });
  assert.equal(calls, 4, "bounded eviction requires verification again");
  cache.clear();

  const observed = Identity.createVerifiedIdentityCache();
  let revision = 0, verifications = 0;
  const seen = [];
  const options = { identity: previous => {
    seen.push(previous);
    return { revision, paths: previous?.paths || ["owned"] };
  }, verify: () => { verifications++; return { paths: ["owned"], revision }; } };
  const first = observed.verify("entry", options);
  assert.equal(seen[0], undefined, "first-use identity receives no successful value");
  assert.equal(seen[1], first, "post-verification identity receives the successful result");
  assert.equal(observed.verify("entry", options), first);
  assert.equal(seen.at(-1), first, "warm identity receives the previous successful value");
  assert.equal(verifications, 1, "unchanged facts skip the callback");
  revision++;
  const changed = observed.verify("entry", options);
  assert.notEqual(changed, first); assert.equal(verifications, 2, "changed observed facts require verification");
  assert.equal(seen.at(-2), first); assert.equal(seen.at(-1), changed);
  assert.equal(observed.verify("entry", options), changed);
  assert.equal(verifications, 2);
});
