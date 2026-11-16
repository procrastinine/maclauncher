const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {finished} = require("node:stream/promises"), {spawnSync} = require("node:child_process"), test = require("node:test");
let electron;
try { electron = require("electron"); } catch {}

for (const unpacked of [false, true]) test(`Electron ${unpacked ? "unpacked" : "packed"} graphics declarations retain caching and source-change checks`, {
  skip: typeof electron !== "string" || !fs.existsSync(electron), timeout: 20000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-publication-asar-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "source"), shared = "src/modules/shared/", repo = path.join(__dirname, "..");
  // The archive holds the publication module and every file it reaches through a relative require or import.
  for (const pending = [path.join(repo, shared, "reshade/publication.js")], seen = new Set(); pending.length;) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    const target = path.join(source, path.relative(repo, file)); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.copyFileSync(file, target);
    if (!/\.[cm]?js$/.test(file)) continue;
    for (const [, request] of fs.readFileSync(file, "utf8").matchAll(/(?:require\(|import\(|from\s+)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), request);
      const found = [base, base + ".js", base + ".cjs", base + ".mjs", base + ".json", path.join(base, "index.js")].find(candidate => fs.statSync(candidate, {throwIfNoEntry: false})?.isFile());
      if (found) pending.push(found);
    }
  }
  const relative = shared + "reshade/distribution-supplementals.json";
  const declaration = [{id: "reshade", version: "first", directoryRelative: "reshade/first/universal", manifestRelative: "runtime.json",
    manifestSha256: "a".repeat(64), files: [{path: "runtime.json", size: 2, sha256: "b".repeat(64)}]}];
  fs.writeFileSync(path.join(source, relative), JSON.stringify(declaration));
  const archive = path.join(root, "app.asar");
  await finished(await require("@electron/asar").createPackageWithOptions(source, archive, unpacked ? {unpack: path.join(source, relative)} : {}));
  const runner = path.join(root, "check.cjs");
  fs.writeFileSync(runner, `
const assert=require('node:assert/strict'),fs=require('node:fs'),raw=require('original-fs');
const {archive,relative,unpacked}=JSON.parse(process.argv[2]),file=archive+'/'+relative;
const Publication=require(archive+'/src/modules/shared/reshade/publication.js');
assert.notEqual(fs.lstatSync(file,{bigint:true}).ino,fs.lstatSync(file,{bigint:true}).ino);
const read=fs.readFileSync;let reads=0;
fs.readFileSync=function(target,...args){if(target===file)reads++;return read(target,...args);};
const reader=Publication.createReader(file),first=reader.current();
assert.equal(first.version,'first');for(let i=0;i<3;i++)assert.equal(reader.current(),first);
assert.equal(reads,1,'Warm reads reuse the accepted declaration');
let changed=false;
fs.readFileSync=function(target,...args){const bytes=read(target,...args);if(target===file&&!changed){changed=true;
if(unpacked)raw.writeFileSync(archive+'.unpacked/'+relative,String(bytes).replace('first','later'));
else raw.utimesSync(archive,new Date(1000),new Date(2000));}return bytes;};
assert.throws(()=>Publication.createReader(file).current(),/changed while being read/);
assert.equal(changed,true);fs.readFileSync=read;
assert.equal(reader.current().version,unpacked?'later':'first');
console.log(JSON.stringify({passed:true,unpacked}));
`);
  const result = spawnSync(electron, [runner, JSON.stringify({archive, relative, unpacked})], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: "1"}, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});
