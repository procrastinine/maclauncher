const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const producer = path.resolve(__dirname, "../src/modules/shared/runtime/steamworks/source-package.py");
const python = ["python3", "/usr/bin/python3"].find(command =>
  spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0);
const options = { skip: !python };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

function temporary(context) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "steam-source-package-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function pythonJson(code, value) {
  const result = spawnSync(python, ["-c", code], { input: JSON.stringify(value), encoding: "utf8", env: environment, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(root, entries, name = "input.tar.gz") {
  const file = path.join(root, name);
  pythonJson(`
import sys,json,base64,io,tarfile
value=json.load(sys.stdin)
with tarfile.open(value["file"],"w:gz",format=tarfile.PAX_FORMAT) as archive:
 for row in value["entries"]:
  member=tarfile.TarInfo(row["name"])
  member.uid=row.get("uid",501);member.gid=row.get("gid",20)
  member.uname=row.get("uname","example-user");member.gname="example-group"
  member.mtime=row.get("mtime",1710000000.5);member.mode=row.get("mode",420)
  member.type=row.get("type","0").encode("ascii")
  member.linkname=row.get("linkname","")
  data=base64.b64decode(row.get("base64",""))
  member.size=row.get("declaredSize",len(data)) if member.isfile() else 0
  archive.addfile(member,io.BytesIO(data) if member.isfile() else None)
print(json.dumps({"done":True}))
`, { file, entries: entries.map(row => ({ ...row, base64: Buffer.from(row.bytes || "").toString("base64") })) });
  return { file, sha256: sha(fs.readFileSync(file)) };
}
function run(input, output, extra = []) {
  return spawnSync(python, [producer, "--input", input.file, "--sha256", input.sha256, "--output", output, ...extra],
    { encoding: "utf8", env: environment, timeout: 10000 });
}
function success(input, output, extra) {
  const result = run(input, output, extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function members(file) {
  return pythonJson(`
import sys,json,tarfile,hashlib
file=json.load(sys.stdin)["file"]
with tarfile.open(file,"r:gz") as archive:
 result=[]
 for member in archive:
  data=archive.extractfile(member).read()
  result.append({"name":member.name,"sha256":hashlib.sha256(data).hexdigest(),"mode":member.mode,
   "uid":member.uid,"gid":member.gid,"uname":member.uname,"gname":member.gname,"mtime":member.mtime,"pax":member.pax_headers})
print(json.dumps(result))
`, { file });
}

test("source package is reproducible across entry order, owner metadata and timestamps while preserving SDK bytes", options, context => {
  const root = temporary(context);
  const rows = [{ name: "source/sdk/steam_api.h", bytes: "Valve copyright; separate SDK terms\n" },
    { name: "source/run.sh", bytes: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    { name: "source/__pycache__/build.pyc", bytes: "generated cache" },
    { name: "source/old.pyc", bytes: "generated cache" },
    { name: "source/old.pyo", bytes: "generated cache" },
    { name: "source/framework/.git", bytes: "gitdir: ../../private-metadata" }];
  const a = fixture(root, rows, "a.tar.gz");
  const b = fixture(root, [...rows].reverse().map(row => ({ ...row, uid: 777, gid: 888, uname: "another-user", mtime: 42 })), "b.tar.gz");
  const outputA = path.join(root, "a-output.tar.gz"), outputB = path.join(root, "b-output.tar.gz");
  const first = success(a, outputA), second = success(b, outputB);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(fs.readFileSync(outputA), fs.readFileSync(outputB));
  assert.equal(first.retainedInputFiles, 2);
  assert.equal(first.removedGeneratedCaches.length, 3);
  assert.equal(first.removedRepositoryMetadata.length, 1);
  assert.equal(first.privatePathScanComplete, true);
  const output = members(outputA);
  assert.deepEqual(output.map(row => row.name), ["source/run.sh", "source/sdk/steam_api.h"]);
  for (const row of output) {
    assert.equal(row.uid, 0); assert.equal(row.gid, 0);
    assert.equal(row.uname, ""); assert.equal(row.gname, ""); assert.equal(row.mtime, 0);
    assert.deepEqual(row.pax, {});
  }
  assert.equal(output[0].mode, 0o755);
  assert.equal(output[1].sha256, sha(Buffer.from(rows[0].bytes)));
  const gzip = fs.readFileSync(outputA);
  assert.equal(gzip.readUInt32LE(4), 0);
  assert.equal(gzip[3], 0, "no producer filename or optional identifying gzip fields");
  assert.equal(gzip[9], 255, "neutral gzip OS marker");
  assert.equal(sha(fs.readFileSync(a.file)), a.sha256, "original archive stays unchanged");
});

test("source context retains exact reviewed fixtures and refuses changed or missing context bytes", options, context => {
  const root = temporary(context), name = "source/tests/test-certificate.pem";
  const bytes = ["-----BEGIN ", "PRIVATE KEY-----\npublic upstream test fixture\n"].join("");
  const input = fixture(root, [{ name, bytes }]);
  const inventory = path.join(root, "context.json");
  const value = { archiveSha256: input.sha256, records: [{ member: name, sha256: sha(Buffer.from(bytes)), kind: "upstream_fixture" }] };
  fs.writeFileSync(inventory, JSON.stringify(value));
  assert.equal(success(input, path.join(root, "accepted.tar.gz"), ["--context", inventory]).reviewedContextFiles, 1);
  value.records[0].sha256 = "0".repeat(64);
  fs.writeFileSync(inventory, JSON.stringify(value));
  const changed = path.join(root, "changed.tar.gz");
  const failed = run(input, changed, ["--context", inventory]);
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /source context changed/);
  assert.equal(fs.existsSync(changed), false);
  value.records[0].member = "source/missing.pem";
  fs.writeFileSync(inventory, JSON.stringify(value));
  const missing = run(input, path.join(root, "missing.tar.gz"), ["--context", inventory]);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /context members are missing/);
});

test("source package additions are explicit, sealed and cannot overwrite an existing source member", options, context => {
  const root = temporary(context), input = fixture(root, [{ name: "source/readme.txt", bytes: "original source" }]);
  const notice = path.join(root, "sdk-notice.txt");
  fs.writeFileSync(notice, "SDK sources retain separate terms; distribution eligibility unresolved.\n");
  const output = path.join(root, "output.tar.gz");
  const record = success(input, output, ["--add", "notices/sdk-source.txt=" + notice]);
  assert.equal(record.retainedInputFiles, 1);
  assert.equal(record.files, 2);
  assert.equal(members(output)[0].sha256, sha(fs.readFileSync(notice)));
  const duplicate = path.join(root, "duplicate.tar.gz");
  assert.notEqual(run(input, duplicate, ["--add", "source/readme.txt=" + notice]).status, 0);
  assert.equal(fs.existsSync(duplicate), false);
});

test("private build paths in normal source bytes or embedded UTF-16 stop publication", options, context => {
  const root = temporary(context);
  const privatePath = ["/Users/", "example-person/projects/", "maclauncher/", ".local/runtime-tests/build/source.cpp"].join("");
  for (const [index, bytes] of [Buffer.from(privatePath), Buffer.concat([Buffer.from([1]), Buffer.from(privatePath, "utf16le")])].entries()) {
    const input = fixture(root, [{ name: "source/generated-config.txt", bytes }], "input-" + index + ".tar.gz");
    const output = path.join(root, "output-" + index + ".tar.gz");
    const result = run(input, output);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /private build path/);
    assert.equal(result.stderr.includes(privatePath), false, "failure does not expose the private path");
    assert.equal(fs.existsSync(output), false);
  }
});

test("pinned input failures and existing outputs remain untouched", options, context => {
  const root = temporary(context), input = fixture(root, [{ name: "source/ok.txt", bytes: "source" }]);
  const output = path.join(root, "output.tar.gz");
  assert.notEqual(run({ ...input, sha256: "0".repeat(64) }, output).status, 0);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, "preexisting output");
  assert.notEqual(run(input, output).status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "preexisting output");
  assert.equal(sha(fs.readFileSync(input.file)), input.sha256);
});

test("unsafe archive paths, symbolic/hard links and duplicate members fail before output", options, context => {
  const root = temporary(context);
  const invalid = [
    [{ name: "../escape.txt", bytes: "escape" }],
    [{ name: "/absolute.txt", bytes: "escape" }],
    [{ name: "source/.git/config", bytes: "private Git config" }],
    [{ name: "source/link", type: "2", linkname: "outside" }],
    [{ name: "source/link", type: "1", linkname: "outside" }],
    [{ name: "source/duplicate", bytes: "first" }, { name: "source/duplicate", bytes: "second" }]
  ];
  for (const [index, rows] of invalid.entries()) {
    const input = fixture(root, rows, "invalid-" + index + ".tar.gz");
    const output = path.join(root, "invalid-output-" + index + ".tar.gz");
    assert.notEqual(run(input, output).status, 0);
    assert.equal(fs.existsSync(output), false);
  }
});

test("oversized archive metadata fails before a payload or output allocation", options, context => {
  const root = temporary(context), file = path.join(root, "oversized-metadata.tar.gz");
  pythonJson(`
import json,sys,tarfile,gzip
value=json.load(sys.stdin)
member=tarfile.TarInfo("PaxHeader")
member.type=tarfile.XHDTYPE;member.size=65537
with gzip.open(value["file"],"wb") as output:
 output.write(member.tobuf(format=tarfile.USTAR_FORMAT));output.write(b"\\0"*1024)
print(json.dumps({"done":True}))
`, { file });
  const input = { file, sha256: sha(fs.readFileSync(file)) }, output = path.join(root, "output.tar.gz");
  const result = run(input, output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /size limit/);
  assert.equal(fs.existsSync(output), false);
});
