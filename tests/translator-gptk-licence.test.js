const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Dmg = require("../src/modules/shared/runtime/dmg");
const Custom = require("../src/modules/shared/runtime/custom-runtime");
const { createManager } = require("../src/modules/shared/runtime/translator-managers");
const { image, X64 } = require("./fixtures/macho-image");

const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const rtf = text => `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0 ${text}\\par}`;
// An evaluation environment volume: redist with D3DMetal and Apple's notices.
function volume(directory, version, licence) {
  const framework = path.join(directory, "redist/lib/external/D3DMetal.framework");
  write(path.join(framework, "Versions/A/D3DMetal"), image({ cpu: X64, fileType: 6, installName: "@rpath/D3DMetal.framework/Versions/A/D3DMetal" }));
  write(path.join(framework, "Versions/A/Resources/version.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  fs.symlinkSync("A", path.join(framework, "Versions/Current"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
  fs.symlinkSync("Versions/Current/D3DMetal", path.join(framework, "D3DMetal"));
  write(path.join(directory, "License.rtf"), rtf(licence));
  write(path.join(directory, "Read Me.rtf"), rtf("Read me"));
}
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "translator-gptk-licence-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const volumes = new Map(), userDataDir = path.join(root, "profile");
  // Each disk image is a distinct file whose volume is a prepared folder.
  const disk = (name, version, licence) => {
    const file = path.join(root, `${name}.dmg`), directory = path.join(root, "volumes", name);
    write(file, `${name} image bytes`); volume(directory, version, licence); volumes.set(file, directory);
    return file;
  };
  t.mock.method(Dmg, "withMountedDmg", async (file, _signal, _options, use) => use(volumes.get(file)));
  const manager = createManager("d3dmetal");
  const imports = () => { try { return fs.readdirSync(path.join(userDataDir, "runtimes/imports")); } catch { return []; } };
  // Each consent also records the files imported so far.
  const register = (runtimePath, consent) => {
    const plans = [];
    return { plans, result: Custom.register(manager, { userDataDir, runtimePath, sectionId: "default", logger: { warn() {} },
      confirmRuntimeInstall: async plan => {
        plans.push({ ...plan, copied: imports().flatMap(name => fs.readdirSync(path.join(userDataDir, "runtimes/imports", name))) });
        return consent;
      } }) };
  };
  const accepted = () => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(userDataDir, "runtimes/accepted-licences.json"), "utf8")).accepted); } catch { return []; } };
  return { disk, manager, register, imports, accepted, userDataDir };
}
const agree = { approved: true, licenseAccepted: true };

test("declining Apple's licence cancels the import and keeps nothing", async t => {
  const f = setup(t), toolkit = f.disk("toolkit", "4.0b3", "Apple licence one");
  const { plans, result } = f.register(toolkit, false);
  await assert.rejects(result, error => error.name === "AbortError");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].licenseRequired, true);
  assert.match(plans[0].detail, /Apple licence one/);
  assert.doesNotMatch(plans[0].detail, /\\rtf1/, "the licence is shown as text");
  assert.deepEqual(plans[0].copied, [], "the licence is shown before anything is copied from the disk image");
  assert.deepEqual(f.imports(), [], "neither the import nor its staging folder remains");
  assert.deepEqual(f.accepted(), []);
  assert.deepEqual(Custom.forManager(f.manager).records(f.userDataDir), []);
});

test("an accepted licence imports the toolkit and is not shown again", async t => {
  const f = setup(t), toolkit = f.disk("toolkit", "4.0b3", "Apple licence one"), again = f.disk("again", "4.0b4", "Apple licence one");
  const first = f.register(toolkit, agree);
  await first.result;
  assert.equal(first.plans.length, 1);
  assert.equal(f.accepted().length, 1);
  assert.equal(Custom.forManager(f.manager).records(f.userDataDir).length, 1);
  const [imported] = f.imports();
  assert.ok(fs.existsSync(path.join(f.userDataDir, "runtimes/imports", imported, "License.rtf")), "Apple's licence stays with the import");
  // The same licence in the same or another disk image is not shown again.
  const repeated = f.register(toolkit, false), other = f.register(again, false);
  await repeated.result; await other.result;
  assert.deepEqual([...repeated.plans, ...other.plans], []);
  assert.equal(Custom.forManager(f.manager).records(f.userDataDir).length, 2);
});

test("a changed licence is shown again before the import is kept", async t => {
  const f = setup(t), toolkit = f.disk("toolkit", "4.0b3", "Apple licence one"), changed = f.disk("changed", "4.1", "Apple licence two");
  await f.register(toolkit, agree).result;
  const declined = f.register(changed, false);
  await assert.rejects(declined.result, error => error.name === "AbortError");
  assert.match(declined.plans[0].detail, /Apple licence two/);
  assert.equal(f.imports().length, 1);
  const accepted = f.register(changed, agree);
  await accepted.result;
  assert.equal(accepted.plans.length, 1);
  assert.equal(f.accepted().length, 2);
  assert.equal(f.imports().length, 2);
});
