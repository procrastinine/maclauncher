const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const M = require("../src/modules/rgss/marshal");
const S = require("../src/modules/rgss/script-tools");

// Independent Ruby Marshal.dump + Zlib::Deflate fixtures preserve duplicate
// IDs/names, an empty name, binary source, and a shared compressed payload.
const SCRIPTS = Buffer.from("BAhbCFsIaRFJIglzYW1lBjoGRVQiGXicKygtKVawSsssKi7hAgAeAARZWwhpEUkiCXNhbWUGOwBUIhp4nCsoLSlWsCpOTc7PS+ECACLtBK1bCGn6SSIABjsAVCIPeJz7zwAAAgABAA==", "base64");
const SHARED = Buffer.from("BAhbB1sIaQZJIgZhBjoGRVQiFHicK85ILEpN4QIAC0oCglsIaQdJIgZiBjsAVEAI", "base64");

function fixture(t, original = SCRIPTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rgss-scripts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "Scripts.rvdata2");
  fs.writeFileSync(sourcePath, original);
  const outputDir = path.join(root, "export");
  const result = S.exportScripts({ sourcePath, outputDir, engineVariant: "RGSS3", runtime: { id: "mkxpz", configuredVersion: "fixture-version", runtimeLoadValidated: false } });
  return { root, sourcePath, outputDir, result };
}

test("ordered script export preserves duplicate/empty names, IDs, encoding ivars and binary source", t => {
  const { outputDir, result, sourcePath } = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json")));
  assert.equal(result.scriptCount, 3);
  assert.deepEqual(manifest.scripts.map(script => script.id), [12, 12, -1]);
  assert.deepEqual(manifest.scripts.map(script => script.nameBase64), ["c2FtZQ==", "c2FtZQ==", ""]);
  assert.deepEqual(manifest.scripts.map(script => script.file), ["000000-12.rb", "000001-12.rb", "000002--1.rb"]);
  assert.equal(manifest.runtime.configuredVersion, "fixture-version");
  assert.deepEqual(fs.readFileSync(path.join(outputDir, "000002--1.rb")), Buffer.from([255, 0]));
  const rebuilt = S.repackScripts({ exportDir: outputDir });
  assert.equal(rebuilt.changedCount, 0);
  assert.deepEqual(rebuilt.buffer, SCRIPTS);
  assert.deepEqual(fs.readFileSync(sourcePath), SCRIPTS);
  assert.throws(() => S.exportScripts({ sourcePath, outputDir }), /EEXIST/);
});

test("single source edit keeps original names/order/identity and untouched compressed bytes", t => {
  const { outputDir, sourcePath, root } = fixture(t);
  const source = Buffer.from("puts :edited\n");
  fs.writeFileSync(path.join(outputDir, "000001-12.rb"), source);
  const result = S.repackScripts({ exportDir: outputDir });
  assert.equal(result.changedCount, 1);
  const before = S.decodeScripts(SCRIPTS);
  const after = S.decodeScripts(result.buffer);
  assert.deepEqual(after.scripts[1].source, source);
  assert.deepEqual(after.scripts[0].compressed, before.scripts[0].compressed);
  assert.deepEqual(after.scripts[2].compressed, before.scripts[2].compressed);
  assert.deepEqual(after.graph.streams[0].objects, before.graph.streams[0].objects);
  assert.deepEqual(after.graph.streams[0].symbols, before.graph.streams[0].symbols);
  const outputPath = path.join(root, "repacked.rvdata2");
  S.writeRepackedScripts({ exportDir: outputDir, outputPath });
  assert.deepEqual(fs.readFileSync(outputPath), result.buffer);
  assert.deepEqual(fs.readFileSync(sourcePath), SCRIPTS);
  assert.throws(() => S.writeRepackedScripts({ exportDir: outputDir, outputPath }), /EEXIST/);
});

test("repacked controlled fixture loads in Ruby and inflates expected source without executing scripts", t => {
  const ruby = spawnSync("ruby", ["-v"], { encoding: "utf8" });
  if (ruby.error?.code === "ENOENT") { t.skip("Ruby unavailable; static fixture coverage still runs"); return; }
  const { outputDir, root } = fixture(t);
  fs.writeFileSync(path.join(outputDir, "000000-12.rb"), "# fixture edit\n");
  const outputPath = path.join(root, "repacked.rvdata2");
  S.writeRepackedScripts({ exportDir: outputDir, outputPath });
  // Only our tiny fixed Array/String/Integer fixture is passed to Marshal.load.
  // No third-party files or custom classes/hooks are loaded or evaluated.
  const check = spawnSync("ruby", ["-rzlib", "-rjson", "-e", "a=Marshal.load(File.binread(ARGV[0])); abort 'ids' unless a.map{|r|r[0]} == [12,12,-1]; abort 'names' unless a.map{|r|r[1]} == ['same','same','']; abort 'source' unless Zlib::Inflate.inflate(a[0][2]) == \"# fixture edit\\n\"; abort 'binary' unless Zlib::Inflate.inflate(a[2][2]).bytes == [255,0]; puts JSON.generate(a.map{|r|r[1].encoding.name})", outputPath], { encoding: "utf8", timeout: 10000 });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), ["UTF-8", "UTF-8", "UTF-8"]);
});

test("shared compressed payload requires consistent edits and preserves alias identity", t => {
  const { outputDir } = fixture(t, SHARED);
  fs.writeFileSync(path.join(outputDir, "000000-1.rb"), "changed\n");
  assert.throws(() => S.repackScripts({ exportDir: outputDir }), /edited consistently/);
  fs.writeFileSync(path.join(outputDir, "000001-2.rb"), "changed\n");
  const result = S.repackScripts({ exportDir: outputDir });
  const after = S.decodeScripts(result.buffer);
  assert.equal(result.changedCount, 2);
  assert.equal(after.scripts[0].payloadNode, after.scripts[1].payloadNode);
  assert.deepEqual(after.scripts[0].source, Buffer.from("changed\n"));
});

test("script tools reject manifest tampering, traversal, corrupt baselines, symlinks and oversized inflate", t => {
  const { outputDir, root } = fixture(t);
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.scripts[0].file = "../outside.rb";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => S.repackScripts({ exportDir: outputDir }), /does not match/);
  manifest.scripts[0].file = "000000-12.rb";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.rmSync(path.join(outputDir, "000000-12.rb"));
  const outside = path.join(root, "outside.rb");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(outputDir, "000000-12.rb"));
  assert.throws(() => S.repackScripts({ exportDir: outputDir }), /ELOOP|symbolic/);
  assert.throws(() => S.decodeScripts(SCRIPTS, { maxScriptBytes: 2 }), /Cannot inflate/);
  assert.throws(() => S.decodeScripts(SCRIPTS, { maxTotalSourceBytes: 2 }), /total source/);
  fs.writeFileSync(path.join(outputDir, "original.bin"), Buffer.from([4, 8, 48]));
  assert.throws(() => S.repackScripts({ exportDir: outputDir }), /hash mismatch/);
  assert.throws(() => S.readBoundedFile(outside, 2), /byte limit/);
  assert.throws(() => S.decodeScripts(Buffer.from([4, 8, 48])), /must contain an Array/);
  const graph = M.parseMarshal(SCRIPTS);
  const payload = S.decodeScripts(SCRIPTS).scripts[0].payloadNode;
  const trailing = M.replaceStrings(graph, new Map([[payload, Buffer.concat([graph.nodes[payload].bytes, Buffer.from("junk")])]]));
  assert.throws(() => S.decodeScripts(trailing), /Trailing data/);
});
