const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

const TERMS = "https://terms.example/pack";
// One Play needing a runtime download and a pack under its publisher's terms.
async function playDialog(packPlan) {
  const plans = [];
  const managers = ["host", "pack"].map(id => ({ id, label: id, getState: () => ({ catalog: {} }), installRuntime: async () => ({}) }));
  const mod = { runtimeManagers: managers, ensureRuntime: () => ({ managerId: "host", label: "Host", version: "1", requiresDownload: true }),
    getRuntimeRequirements: async () => [{ managerId: "pack", label: "Pack", version: "2", requiresDownload: true, ...packPlan }] };
  const context = { userDataDir: "/nonexistent", runtimeId: "host", settings: {}, confirmRuntimeInstall: async plan => { plans.push(plan); return false; } };
  assert.equal(await prepareForLaunch({ entry: { name: "Fixture" }, mod, info: { runtime: {} }, context,
    registry: { listModuleIds: () => ["fixture"], getModule: () => mod }, runAction: () => assert.fail("No action required"),
    install: () => assert.fail("Cancel installs nothing") }), false);
  assert.equal(plans.length, 1, "one Play dialog");
  return plans[0];
}

test("a download that joins the Play dialog keeps its licence in that dialog", async () => {
  const named = await playDialog({ licenseRequired: true, licenseUrl: TERMS, detail: `Publisher's terms apply: ${TERMS}` });
  assert.deepEqual(named.companions.map(item => [item.label, item.licenseRequired, item.licenseUrl]), [["Pack", true, TERMS]]);
  const described = await playDialog({ licenseRequired: true, detail: "Publisher's terms apply." });
  assert.deepEqual(described.companions.map(item => [item.licenseRequired, item.licenseUrl, item.detail]), [[true, undefined, "Publisher's terms apply."]]);
  const plain = await playDialog({ detail: "Shared between games." });
  assert.deepEqual(plain.companions.map(item => [item.licenseRequired, item.detail]), [[undefined, undefined]], "a download without a licence is listed by name");
});

test("the RTP pack names its publisher's terms as its licence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/rgss/rtp.js"), "utf8");
  assert.ok(/licenseRequired: true, licenseUrl: pack\.termsUrl/.test(source), "the RTP plan names pack.termsUrl as licenseUrl");
});

test("the Play dialog shows each listed licence and asks to agree", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const code = source.slice(source.indexOf("async function confirmRuntimeInstallation("), source.indexOf("\nfunction logRuntimeToolSpawn("));
  const shown = [];
  const context = { path, getLauncherDialogOwner: () => null, dialog: { showMessageBox: async options => { shown.push(options); return { response: 0 }; } } };
  vm.createContext(context); vm.runInContext(code, context);
  const agreed = await context.confirmRuntimeInstallation({ label: "MKXP-Z", versionLabel: "2.4", companions: [
    { label: "RPG Maker XP RTP", versionLabel: "1.04", bytes: 10485760, licenseRequired: true, licenseUrl: TERMS },
    { label: "Fonts", versionLabel: "1", licenseRequired: true, detail: "Font terms apply." }, { label: "Shaders", versionLabel: "3" }] }, { name: "Fixture" });
  assert.equal(shown[0].message, "Download what Fixture needs?");
  assert.equal(shown[0].detail, `MKXP-Z 2.4\nRPG Maker XP RTP 1.04 (10.0 MB)\nFonts 1\nShaders 3\n\nRPG Maker XP RTP license: ${TERMS}\nFonts: Font terms apply.`);
  assert.deepEqual(Array.from(shown[0].buttons), ["Agree, Download and Play", "Cancel"]);
  assert.deepEqual({ ...agreed }, { approved: true, licenseAccepted: true });
  // The download that leads the dialog can carry the licence as well.
  const led = await context.confirmRuntimeInstallation({ label: "Pack", versionLabel: "2", licenseRequired: true, licenseUrl: TERMS,
    companions: [{ label: "Host", versionLabel: "1" }] }, { name: "Fixture" });
  assert.equal(shown[1].detail, `Pack 2\nHost 1\n\nPack license: ${TERMS}`);
  assert.deepEqual(Array.from(shown[1].buttons), ["Agree, Download and Play", "Cancel"]);
  assert.deepEqual({ ...led }, { approved: true, licenseAccepted: true });
  // Without a licence the dialog is unchanged.
  assert.equal(await context.confirmRuntimeInstallation({ label: "Host", versionLabel: "1", companions: [{ label: "Shaders", versionLabel: "3" }] }, { name: "Fixture" }), true);
  assert.deepEqual([shown[2].detail, Array.from(shown[2].buttons)], ["Host 1\nShaders 3", ["Download and Play", "Cancel"]]);
});

test("the command line asks to agree to a licence listed with another download", async () => {
  const file = require.resolve("../src/core/game-cli"), load = createRequire(file);
  for (const [args, expected] of [[["--yes"], false], [["--yes", "--accept-runtime-licenses"], true]]) {
    let answer;
    const errors = [], processState = { env: {}, argv: [], stdin: { isTTY: false }, stderr: {}, exitCode: 0 };
    const stubs = {
      "./game-cli-environment": { initializeCommandEnvironment: () => ({ appPath: "/test/source", createApp: () => ({}) }) },
      "./launcher": { createLauncher: options => ({ userDataDir: "/test/profile", loadSettings: () => ({}),
        resolveEntry: async () => ({ gameId: "test", gamePath: "/test/game", name: "Test" }),
        launchEntry: async () => { answer = await options.confirmRuntimeInstall({ label: "MKXP-Z", versionLabel: "2.4", requiresDownload: true,
          companions: [{ label: "RPG Maker XP RTP", versionLabel: "1.04", licenseRequired: true, licenseUrl: TERMS }] }); return { kind: "cancelled" }; } }) },
      "./game-store": {}, "./electron-binary": {}, "../modules/registry": {}, "./process-lifecycle": {},
      "../main/game-command": { resolveGameCommandPath: (_data, game) => game },
      "node:readline/promises": { createInterface: () => assert.fail("No terminal prompt without a TTY") }
    };
    const mockedRequire = id => Object.hasOwn(stubs, id) ? stubs[id] : load(id);
    const context = { require: mockedRequire, module: { exports: {} }, process: processState,
      console: { error: message => errors.push(String(message)), log() {} }, __dirname: path.dirname(file) };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    await context.module.exports.runGameCli(["--game", "/test/game", "--user-data", "/test/profile", ...args]);
    if (expected) assert.deepEqual({ ...answer }, { approved: true, licenseAccepted: true });
    else {
      assert.equal(answer, undefined, "--yes alone does not agree to a licence");
      assert.match(errors.join("\n"), /--accept-runtime-licenses/);
    }
  }
});
