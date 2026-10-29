const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { writeLatestReport } = require("../src/modules/shared/generated-reports");

test("reports replace atomically, migrate only their own old files, and preserve the last success on failure", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-reports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "old-saves.json"), "old");
  fs.writeFileSync(path.join(root, "inspection.json"), "other kind");
  fs.writeFileSync(path.join(root, "notes.json"), "user data");
  fs.symlinkSync(path.join(root, "notes.json"), path.join(root, "linked-saves.json"));
  const options = { legacyFiles: /-saves\.json$/ };
  const output = writeLatestReport(root, "saves.json", { count: 0 }, options);
  assert.equal(fs.existsSync(path.join(root, "old-saves.json")), false);
  assert.equal(fs.lstatSync(path.join(root, "linked-saves.json")).isSymbolicLink(), true);
  assert.equal(writeLatestReport(root, "saves.json", { count: 1 }, options), output);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), { count: 1 });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeLatestReport(root, "saves.json", circular, options));
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), { count: 1 });
  assert.equal(fs.readFileSync(path.join(root, "notes.json"), "utf8"), "user data");
  assert.equal(fs.readFileSync(path.join(root, "inspection.json"), "utf8"), "other kind");
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith(".tmp")));
});

test("legacy report folders with added files and links are preserved", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-directories-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["inspection-aaaaaa", "inspection-bbbbbb"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "inspection.json"), "old");
  }
  fs.writeFileSync(path.join(root, "inspection-bbbbbb", "notes.txt"), "keep");
  fs.symlinkSync(path.join(root, "inspection-bbbbbb"), path.join(root, "inspection-cccccc"));
  writeLatestReport(root, "inspection.json", { ok: true }, { legacyDirectories: /^inspection-[a-z]{6}$/ });
  assert.equal(fs.existsSync(path.join(root, "inspection-aaaaaa")), false);
  assert.equal(fs.readFileSync(path.join(root, "inspection-bbbbbb", "notes.txt"), "utf8"), "keep");
  assert.equal(fs.lstatSync(path.join(root, "inspection-cccccc")).isSymbolicLink(), true);
});
