const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const recipe = path.resolve(__dirname, "../src/modules/gamemaker/overlays/opengmk-macos/source-archive.py");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t, kind = "regular") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "opengmk-source-archive-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "input.tar.gz"), output = path.join(directory, "output.tar.gz");
  const result = spawnSync("python3", ["-c", `
import gzip,io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
 for name,content,mode in [('./source/executable.sh',b'#!/bin/sh\\nexit 0\\n',0o755),('./source/data.txt',b'source bytes\\n',0o640)]:
  info=tarfile.TarInfo(name); info.size=len(content); info.mode=mode
  info.uid=501; info.gid=20; info.uname='build-owner'; info.gname='build-group'; info.mtime=98765
  archive.addfile(info,io.BytesIO(content))
 if sys.argv[2] != 'regular':
  info=tarfile.TarInfo('./source/data.txt' if sys.argv[2]=='duplicate' else '../escape.txt' if sys.argv[2]=='unsafe' else './source/link')
  if sys.argv[2]=='link': info.type=tarfile.SYMTYPE; info.linkname='data.txt'
  archive.addfile(info,io.BytesIO(b''))
`, input, kind], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { directory, input, output };
}

test("corresponding-source creation removes owner metadata while preserving source bytes and restrictive modes", t => {
  const f = fixture(t), before = digest(f.input);
  const create = output => spawnSync("python3", [recipe, f.input, output, "--expected-sha256", before], { encoding: "utf8" });
  const first = create(f.output);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(digest(f.input), before);
  const repeat = path.join(f.directory, "repeat.tar.gz"), second = create(repeat);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(f.output), fs.readFileSync(repeat));
  const repack = path.join(f.directory, "repack.tar.gz");
  const idempotent = spawnSync("python3", [recipe, f.output, repack], { encoding: "utf8" });
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.deepEqual(fs.readFileSync(f.output), fs.readFileSync(repack));
  const inspect = spawnSync("python3", ["-c", `
import json,sys,tarfile
with tarfile.open(sys.argv[1]) as archive:
 print(json.dumps([{'name':m.name,'uid':m.uid,'gid':m.gid,'uname':m.uname,'gname':m.gname,'mtime':m.mtime,'mode':m.mode,
                   'data':archive.extractfile(m).read().decode() if m.isfile() else None} for m in archive]))
`, f.output], { encoding: "utf8" });
  assert.equal(inspect.status, 0, inspect.stderr);
  const members = JSON.parse(inspect.stdout);
  assert.deepEqual(members.map(m => m.name), [...members.map(m => m.name)].sort());
  for (const m of members) assert.deepEqual([m.uid, m.gid, m.uname, m.gname, m.mtime], [0, 0, "", "", 0]);
  assert.equal(members.find(m => m.name === "./source/executable.sh").mode, 0o755);
  assert.equal(members.find(m => m.name === "./source/executable.sh").data, "#!/bin/sh\nexit 0\n");
  assert.equal(members.find(m => m.name === "./source/data.txt").mode, 0o640);
  assert.equal(members.find(m => m.name === "./source/data.txt").data, "source bytes\n");
  for (const name of ["source-archive.py", "SOURCE_ARCHIVE.md"]) {
    assert.equal(members.find(m => m.name === `./maclauncher-overlay/${name}`).data,
      fs.readFileSync(path.join(path.dirname(recipe), name), "utf8"));
  }
  const gzip = fs.readFileSync(f.output);
  assert.equal(gzip.readUInt32LE(4), 0);
  assert.equal(gzip[3] & 8, 0);
});

test("source archive creation preserves existing output and refuses wrong source identities", t => {
  const f = fixture(t);
  fs.writeFileSync(f.output, "existing output\n");
  assert.notEqual(spawnSync("python3", [recipe, f.input, f.output], { encoding: "utf8" }).status, 0);
  assert.equal(fs.readFileSync(f.output, "utf8"), "existing output\n");
  const rejected = path.join(f.directory, "rejected.tar.gz");
  assert.notEqual(spawnSync("python3", [recipe, f.input, rejected, "--expected-sha256", "0".repeat(64)], { encoding: "utf8" }).status, 0);
  assert.equal(fs.existsSync(rejected), false);
  const before = digest(f.input);
  assert.notEqual(spawnSync("python3", [recipe, f.input, f.input], { encoding: "utf8" }).status, 0);
  assert.equal(digest(f.input), before);
});

for (const kind of ["duplicate", "unsafe", "link"]) test(`source archive creation rejects ${kind} members before writing output`, t => {
  const f = fixture(t, kind), before = digest(f.input);
  assert.notEqual(spawnSync("python3", [recipe, f.input, f.output], { encoding: "utf8" }).status, 0);
  assert.equal(digest(f.input), before);
  assert.equal(fs.existsSync(f.output), false);
});
