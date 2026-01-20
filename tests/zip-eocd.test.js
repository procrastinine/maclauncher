const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Zip = require("../src/modules/shared/runtime/zip");

const repoRoot = path.resolve(__dirname, "..");

function verifyTyranoExe(filePath) {
  const result = Zip.readZipEntries(filePath);
  assert.ok(result);
  assert.ok(result.info.zipBase > 0);
  const names = result.entries.map(entry => entry.name);
  assert.ok(names.includes("builder_config.json"));
  assert.ok(names.some(name => name.startsWith("tyrano/")));
}

test("zip EOCD scan reads TyranoBuilder central directory (Twilight Observer)", t => {
  const exePath = path.join(
    repoRoot,
    ".local",
    "example_games",
    "tyrano_Twilight_Observer",
    "Twilight Observer.exe"
  );
  if (!fs.existsSync(exePath)) {
    t.skip();
    return;
  }
  verifyTyranoExe(exePath);
});

test("zip EOCD scan reads TyranoBuilder central directory (Death Loop)", t => {
  const exePath = path.join(
    repoRoot,
    ".local",
    "example_games",
    "tyrano_Death_Loop",
    "Death Loop.exe"
  );
  if (!fs.existsSync(exePath)) {
    t.skip();
    return;
  }
  verifyTyranoExe(exePath);
});
