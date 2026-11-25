const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

// macOS tar hands zstd to a separate zstd program that macOS does not include,
// so both extractors must read a .tar.zst without one on PATH.
function zstdArchive(root) {
  const source = path.join(root, "source"), plain = path.join(root, "plain.tar"), archive = path.join(root, "vkd3d-proton-3.1.tar.zst");
  fs.mkdirSync(path.join(source, "vkd3d-proton-3.1/x64"), { recursive: true });
  fs.writeFileSync(path.join(source, "vkd3d-proton-3.1/x64/d3d12.dll"), "dll");
  fs.symlinkSync("d3d12.dll", path.join(source, "vkd3d-proton-3.1/x64/alias.dll"));
  execFileSync("/usr/bin/tar", ["-cf", plain, "-C", source, "vkd3d-proton-3.1"]);
  fs.writeFileSync(archive, zlib.zstdCompressSync(fs.readFileSync(plain)));
  return archive;
}

function withoutZstdOnPath(t) {
  const saved = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  t.after(() => { process.env.PATH = saved; });
}

for (const [name, load] of [["safe-archive", () => require("../src/modules/shared/runtime/safe-archive")],
  ["release-files", () => require("../src/modules/shared/runtime/release-files")]]) {
  test(`${name} extracts a .tar.zst without a zstd program and leaves no expanded tar behind`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zstd-archive-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    withoutZstdOnPath(t);
    const archive = zstdArchive(root), stage = path.join(root, "stage"), output = path.join(stage, "out");
    fs.mkdirSync(output, { recursive: true });
    await load().extractArchive(archive, output);
    assert.equal(fs.readFileSync(path.join(output, "vkd3d-proton-3.1/x64/d3d12.dll"), "utf8"), "dll");
    assert.equal(fs.readlinkSync(path.join(output, "vkd3d-proton-3.1/x64/alias.dll")), "d3d12.dll");
    assert.deepEqual(fs.readdirSync(stage), ["out"]);
  });
}

test("a damaged .tar.zst fails and removes its partial expansion", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zstd-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "broken.tar.zst"), output = path.join(root, "out");
  fs.writeFileSync(archive, Buffer.from("not zstd data"));
  fs.mkdirSync(output);
  await assert.rejects(require("../src/modules/shared/runtime/safe-archive").extractArchive(archive, output));
  assert.deepEqual(fs.readdirSync(root).sort(), ["broken.tar.zst", "out"]);
});
