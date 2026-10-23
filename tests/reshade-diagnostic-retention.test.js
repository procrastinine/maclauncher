const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pruneDiagnostics } = require("../src/modules/shared/reshade/diagnostic-retention");

test("unreadable diagnostic history never interrupts preparation", t => {
  t.mock.method(fs, "readdirSync", () => {throw Object.assign(new Error("Unavailable diagnostic directory"), {code: "EACCES"});});
  assert.doesNotThrow(() => pruneDiagnostics("/unused"));
});

test("graphics diagnostic history is bounded without deleting active writers or other files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-diagnostic-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = (id, kind = "diagnostics") => `${kind}-00000000-0000-0000-0000-000000000000.${id}.jsonl`;
  for (let id = 1; id <= 100; id++) {
    const file = path.join(root, name(id)); fs.writeFileSync(file, Buffer.alloc(128)); fs.utimesSync(file, id, id);
  }
  fs.writeFileSync(path.join(root, "prepared.fx"), "original effect");
  const external = path.join(root, "external.txt"); fs.writeFileSync(external, "keep");
  fs.symlinkSync(external, path.join(root, name(500)));
  pruneDiagnostics(root, { maxFiles: 5, maxBytes: 384, isProcessAlive: pid => pid === 1 });
  const files = fs.readdirSync(root);
  assert.deepEqual(files.filter(file => /\.jsonl$/.test(file)).sort(), [name(1), name(98), name(99), name(100), name(500)].sort());
  assert.equal(fs.readFileSync(external, "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(root, "prepared.fx"), "utf8"), "original effect");
  pruneDiagnostics(root, { maxFiles: 1, maxBytes: 1024, isProcessAlive: () => false });
  assert.deepEqual(fs.readdirSync(root).filter(file => /\.jsonl$/.test(file)).sort(), [name(100), name(500)].sort());
});
