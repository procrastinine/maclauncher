const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Asar = require("../src/modules/shared/runtime/asar");

test("readAsarHeader parses Electron default_app.asar when available", t => {
  const asarPath = path.join(
    __dirname,
    "..",
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "Resources",
    "default_app.asar"
  );
  if (!fs.existsSync(asarPath)) {
    t.skip();
    return;
  }
  const { header, dataOffset } = Asar.readAsarHeader(asarPath);
  assert.ok(header?.files);
  assert.ok(dataOffset > 0);
  const entries = Asar.listAsarEntries(header, dataOffset);
  assert.ok(entries.some(entry => entry.type === "file" && entry.path.endsWith(".js")));
});
