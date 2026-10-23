const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Content = require("../scripts/runtime-content.cjs");

const overlay = path.resolve(__dirname, "../src/modules/rgss/overlays/mkxpz-filename-nfc");
const fixture = path.join(__dirname, "fixtures/mkxpz-filename-nfc");
const pin = JSON.parse(fs.readFileSync(path.join(overlay, "source.json"), "utf8"));
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

function applyFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mkxpz-nfc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of pin.files) {
    const original = fs.readFileSync(path.join(fixture, file.path));
    assert.equal(sha256(original), file.originalSha256, file.path);
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), original);
  }
  assert.equal(sha256(fs.readFileSync(path.join(overlay, pin.patch.file))), pin.patch.sha256);
  execFileSync("/usr/bin/patch", ["-p1", "--batch", "--forward", "--fuzz=0", "--input", path.join(overlay, pin.patch.file)], { cwd: root, stdio: "pipe" });
  for (const file of pin.files)
    assert.equal(sha256(fs.readFileSync(path.join(root, file.path))), file.adaptedSha256, file.path);
  for (const file of pin.addedFiles) {
    const bytes = fs.readFileSync(path.join(overlay, file.file));
    assert.equal(sha256(bytes), file.sha256, file.file);
    fs.copyFileSync(path.join(overlay, file.file), path.join(root, file.destination));
  }
  return root;
}

test("the exact publisher source accepts the NFC adaptation without changing the path cache or runtime payload", t => {
  const root = applyFixture(t);
  const source = fs.readFileSync(path.join(root, "src/filesystem/filesystem.cpp"), "utf8");
  assert.doesNotMatch(source, /iconv_open|iconv_close|#include <iconv.h>/);
  assert.match(source, /mkxpz_filename_nfc\(inout, normalized, sizeof\(normalized\)\)/);
  assert.match(source, /throw Exception\(Exception::PHYSFSError/);
  assert.match(source, /PHYSFS_enumerate\("", cacheEnumCB, &data\)/);
  assert.match(source, /data\.p->pathCache\.insert\(lowerCase, mixedCase\)/);
  assert.match(fs.readFileSync(path.join(root, "meson.build"), "utf8"), /'CoreFoundation'/);
  for (const file of ["filename-nfc.cpp", ...pin.files.map(file => file.path)])
    assert.ok(Content.excludedReason(path.relative(path.dirname(__dirname), path.join(fixture, file))));
  assert.ok(Content.excludedReason("tests/runtime-mkxpz-filename-nfc.test.js"));
  t.diagnostic(JSON.stringify({ revision: pin.upstream.revision, patchSha256: pin.patch.sha256, files: pin.files }));
});

test("platform NFC preserves complete Unicode names and rejects malformed or oversized paths on macOS 11 targets", { skip: process.platform !== "darwin", timeout: 30000 }, t => {
  const root = applyFixture(t);
  const source = fs.readFileSync(path.join(root, "src/filesystem/filesystem.cpp"), "utf8");
  const cache = source.match(/struct CacheEnumData \{[\s\S]*?\n\};(?=\n\nstatic PHYSFS_EnumerateCallbackResult)/);
  assert.ok(cache, "Compile the actual patched CacheEnumData, including its failure handling");
  fs.writeFileSync(path.join(root, "cache-enum-data.inc"), cache[0] + "\n");
  const cpp = path.join(fixture, "filename-nfc.cpp");
  const common = ["-std=c++11", "-Wall", "-Wextra", "-Werror", "-UNDEBUG", "-I", overlay, "-I", root];
  for (const arch of ["arm64", "x86_64"]) {
    const object = path.join(root, arch + ".o");
    const args = ["clang++", "--target=" + arch + "-apple-macos11.0", ...common, "-c", cpp, "-o", object];
    execFileSync("/usr/bin/xcrun", args, { stdio: "pipe" });
    execFileSync("/usr/bin/xcrun", ["clang", "--target=" + arch + "-apple-macos11.0", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", overlay,
      "-c", path.join(overlay, "macos-filename-nfc.c"), "-o", path.join(root, arch + "-nfc.o")], { stdio: "pipe" });
    t.diagnostic(JSON.stringify({ command: ["/usr/bin/xcrun", ...args], exitCode: 0, objectSha256: sha256(fs.readFileSync(object)) }));
  }
  const executable = path.join(root, "filename-nfc");
  const args = ["clang++", "--target=arm64-apple-macos11.0", ...common, cpp, path.join(root, "arm64-nfc.o"), "-framework", "CoreFoundation", "-o", executable];
  execFileSync("/usr/bin/xcrun", args, { stdio: "pipe" });
  const output = execFileSync(executable, [], { encoding: "utf8", timeout: 10000 });
  assert.match(output, /PASS malformed UTF-8 rejected without replacing the path/);
  assert.match(output, /PASS capacity, terminator, boundary guards and NFC expansion/);
  t.diagnostic(JSON.stringify({ command: ["/usr/bin/xcrun", ...args], exitCode: 0, executableSha256: sha256(fs.readFileSync(executable)), execution: { architecture: "arm64", exitCode: 0, stdout: output } }));
});
