const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const { extractRenpyGame, resolveExtractionStatus, writeExtractionMeta } = require("../src/modules/renpy/extract");
const { buildUnrenCommand } = require("../src/modules/renpy/unren");
const runProcess = promisify(execFile);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renpy-tools-extract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function pythonAvailable(t) {
  const command = buildUnrenCommand();
  const result = spawnSync(command.command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) { t.skip("Python 3 is not available"); return null; }
  return command;
}

test("RPA overlay preserves prefixes and multiple chunks, supports 1/2/3/3.2, and rejects malicious indexes and paths", t => {
  const command = pythonAvailable(t);
  if (!command) return;
  const root = fixture(t);
  const script = String.raw`
import pickle, zlib, sys
from pathlib import Path
from unren.rpa import extract_archives
from unren.patches.rpa import safe_archive_class, load_primitive_index, safe_output_path, decompress_index
from unren.vendor import import_rpatool
root = Path(sys.argv[1])
base = import_rpatool().RenPyArchive
Safe = safe_archive_class(base)
def archive(name, entries, version=3, protocol=4, index_blob=None):
    data = b'abcdef'
    key = 0x42424242 if version in (3, 3.2) else 0
    index = {n: [(o ^ key, length ^ key, prefix) for o, length, prefix in chunks] for n, chunks in entries.items()}
    offset = 128 + len(data)
    if version == 2: header = ('RPA-2.0 %016x\n' % offset).encode()
    elif version == 3.2: header = ('RPA-3.2 %016x 00000000 %08x\n' % (offset,key)).encode()
    else: header = ('RPA-3.0 %016x %08x\n' % (offset,key)).encode()
    p = root / name
    p.write_bytes(header + b' '*(128-len(header)) + data + zlib.compress(index_blob if index_blob is not None else pickle.dumps(index,protocol=protocol)))
    return p
for version in (2,3,3.2):
    p=archive('v%s.rpa'%version, {'script.rpy':[(128,3,b'prefix-'),(131,3,b'')]},version)
    a=Safe(str(p))
    assert a.read('script.rpy') == b'prefix-abcdef'
    result=extract_archives([p],output_dir=root/('out-%s'%version))
    assert result[0].state == 'ok',result[0].error
    assert (root/('out-%s'%version)/'script.rpy').read_bytes()==b'prefix-abcdef'
    a.handle.close()
p=archive('python2.rpa', {'script.rpy':[(128,6,'latin1-prefix')]},protocol=2)
assert Safe(str(p)).read('script.rpy') == b'latin1-prefixabcdef'
(root/'classic.rpi').write_bytes(zlib.compress(pickle.dumps({'script.rpy':[(0,6)]},protocol=2)))
(root/'classic.rpa').write_bytes(b'abcdef')
assert Safe(str(root/'classic.rpi')).read('script.rpy') == b'abcdef'
assert extract_archives([root/'classic.rpi'],output_dir=root/'classic-out')[0].state == 'ok'
for name in ('../escape.rpy','/absolute.rpy','C:/escape.rpy','dir\\escape.rpy'):
    p=archive('unsafe.rpa',{name:[(128,6,b'')]})
    r=extract_archives([p],output_dir=root/'unsafe-out')
    assert r[0].state == 'error'
    assert not (root/'escape.rpy').exists()
class Malicious:
    def __reduce__(self):
        import os
        return (os.system,('touch '+str(root/'executed'),))
p=archive('evil.rpa',{},index_blob=pickle.dumps(Malicious()))
r=extract_archives([p],output_dir=root/'evil-out')
assert r[0].state == 'error' and 'Forbidden' in str(r[0].error)
assert not (root/'executed').exists()
try: load_primitive_index(pickle.dumps({})+b'trailing')
except ValueError: pass
else: raise AssertionError('trailing bytes accepted')
try: decompress_index(zlib.compress(b'x'*(33*1024*1024)))
except ValueError: pass
else: raise AssertionError('oversized index accepted')
p=archive('bounds.rpa',{'script.rpy':[(133,20,b'')]})
assert extract_archives([p],output_dir=root/'bounds-out')[0].state == 'error'
(root/'link-out').mkdir()
(root/'link-out'/'script.rpy').symlink_to(root/'outside')
try: safe_output_path(root/'link-out','script.rpy')
except ValueError: pass
else: raise AssertionError('output symlink accepted')
print('RPA overlay fixtures passed')
`;
  const result = spawnSync(command.command, ["-c", script, root], { env: command.env, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /fixtures passed/);
});

test("transactional extraction copies loose source without touching saves and preserves previous output on errors", async t => {
  const root = fixture(t);
  const gameDir = path.join(root, "game");
  const extractRoot = path.join(root, "user-data", "extracted");
  fs.mkdirSync(path.join(gameDir, "saves"), { recursive: true });
  fs.writeFileSync(path.join(gameDir, "script.rpy"), "label start:\n    return\n");
  fs.writeFileSync(path.join(gameDir, "saves", "private.rpy"), "do not copy");
  fs.mkdirSync(extractRoot, { recursive: true });
  fs.writeFileSync(path.join(extractRoot, "previous.txt"), "previous extraction");
  let fail = true;
  let phases = 0;
  const runner = async (_command, args) => {
    phases++;
    const reportPath = args[args.indexOf("--report") + 1];
    const command = args[0];
    fs.writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, command, pythonVersion: "3.12.1",
      results: [{ state: fail && phases === 1 ? "error" : "ok", error: fail && phases === 1 ? "broken archive" : null, extracted: command === "extract" ? 1 : undefined }] }));
    if (fail && phases === 1) throw new Error("tool failed (1)");
    return { stdout: "ok", stderr: "" };
  };
  const options = { gameDir, extractRoot, renpyVersion: "8.2.0", runCommand: runner,
    buildCommand: () => ({ command: "python", args: [], env: {}, source: "fixture" }) };
  await assert.rejects(extractRenpyGame(options), /Previous extraction was preserved/);
  assert.equal(phases, 3, "later phases collect diagnostics after a file error");
  assert.equal(fs.readFileSync(path.join(extractRoot, "previous.txt"), "utf8"), "previous extraction");
  const failure = JSON.parse(fs.readFileSync(path.join(path.dirname(extractRoot), "extraction-last-failure.json")));
  assert.equal(failure.phases[0].results[0].error, "broken archive");
  fail = false;
  const report = await extractRenpyGame(options);
  assert.equal(report.state, "complete");
  assert.equal(report.renpyVersion, "8.2.0");
  assert.equal(report.phases[0].pythonVersion, "3.12.1");
  assert.equal(report.options.runtimeFallback, false);
  assert.equal(fs.existsSync(path.join(extractRoot, "previous.txt")), false);
  assert.equal(fs.readFileSync(path.join(extractRoot, "script.rpy"), "utf8"), "label start:\n    return\n");
  assert.equal(fs.existsSync(path.join(extractRoot, "saves")), false);
  assert.equal(fs.existsSync(report.reportPath), true);
  assert.equal(fs.existsSync(path.join(path.dirname(extractRoot), "extraction-last-failure.json")), false);
  await assert.rejects(extractRenpyGame({ ...options, mode: "future" }), /mode must be/);
  await assert.rejects(extractRenpyGame({ ...options, extractRoot: path.join(gameDir, "extracted") }), /outside the source/);
});

test("extraction status rejects directories left behind by failed or unrecorded attempts", t => {
  const root = fixture(t);
  const entry = { gameId: "renpy-tools", moduleData: { extractedRoot: root } };
  assert.equal(resolveExtractionStatus({ entry, userDataDir: root }).extractedReady, false);
  writeExtractionMeta(root, { sourcePath: "/game", state: "failed" });
  assert.equal(resolveExtractionStatus({ entry, userDataDir: root }).extractedReady, false);
});

test("actual Ren'Py 7.7 and 8.2 compiled scripts decompile through current bundled tools", async t => {
  const command = pythonAvailable(t);
  if (!command) return;
  const root = fixture(t);
  for (const [vendor, version] of [["unrpyc-legacy", "7.7"], ["unrpyc", "8.2"]]) {
    const script = path.join(command.unrenRoot, "third_party", vendor, "testcases", "compiled", `the_question-${version}`, "script.rpyc");
    if (!fs.existsSync(script)) { t.diagnostic(`Missing bundled ${version} fixture`); continue; }
    const output = path.join(root, version);
    const report = path.join(root, `${version}.json`);
    await runProcess(command.command, [...command.args, "decompile", "--mode", "auto", "--output", output, "--report", report, script], { env: command.env, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(fs.readFileSync(report));
    assert.equal(result.results[0].state, "ok", result.results[0].error);
    assert.ok(result.pythonVersion);
    assert.equal(result.decompilerVersions.current, "v2.0.3");
    assert.equal(result.decompilerVersions.legacyPy3, "v1.3.2");
    const source = fs.readFileSync(path.join(output, "script.rpy"), "utf8");
    assert.match(source, /label start:/);
    assert.match(source, /menu:/);
  }
});
