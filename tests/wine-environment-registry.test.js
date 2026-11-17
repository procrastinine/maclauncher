const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Environment = require("../src/modules/shared/runtime/wine-environment");

// A runtime settings window lists the existing Windows environments each time
// it opens. Each is named from its own settings and user registry; its machine
// registry, several megabytes in a CrossOver bottle, is read only when a
// setting that lives there is.
test("listing Windows environments reads no machine registry until a setting needs it", t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "environment-registry-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bottles = path.join(home, "Library", "Application Support", "CrossOver", "Bottles");
  for (const name of ["First", "Second"]) {
    const bottle = path.join(bottles, name);
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), `[Bottle]\n"Description" = "${name} bottle"\n`);
    fs.writeFileSync(path.join(bottle, "system.reg"), '[Software\\\\Wine]\n"Version"="win7"\n');
    fs.writeFileSync(path.join(bottle, "user.reg"), '[Software\\\\Wine\\\\Mac Driver]\n"RetinaMode"="y"\n');
  }
  const read = fs.readFileSync, opened = [];
  t.mock.method(fs, "readFileSync", function (file, ...args) { opened.push(String(file)); return read.call(this, file, ...args); });

  const rows = Environment.discoverEnvironments("crossover", { home, environment: {} });
  assert.deepEqual(rows.map(row => row.name), ["First bottle", "Second bottle"]);
  assert.equal(rows[0].settings.highResolution, "y", "a bottle's user registry still names its settings");
  assert.deepEqual(opened.filter(file => file.endsWith("system.reg")), [], "listing read no machine registry");

  assert.equal(rows[0].registry["system.reg"]["Software\\Wine"].Version, "win7", "a setting in the machine registry still reads it");
  assert.equal(opened.filter(file => file.endsWith("system.reg")).length, 1);
  rows[0].registry["system.reg"];
  assert.equal(opened.filter(file => file.endsWith("system.reg")).length, 1, "each registry file is read once per record");
  assert.deepEqual(Object.keys(rows[1].registry), ["system.reg", "user.reg", "userdef.reg"]);
});
