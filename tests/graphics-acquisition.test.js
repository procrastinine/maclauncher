// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Sources = require("../src/modules/shared/reshade/model-sources");
const Steam = require("../src/modules/shared/reshade/steam-models");
const Models = require("../src/modules/shared/reshade/models");
const Manager = require("../src/modules/shared/reshade/runtime/models-manager");
const SteamCMDSource = require("../src/modules/shared/reshade/steamcmd-source");
const DeveloperId = require("../src/modules/shared/runtime/developer-id");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-acquisition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function dll(directory, fill = 65) {
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, "Lossless.dll");
  fs.writeFileSync(file, Buffer.alloc(128, fill)); return file;
}
function inspect(file) {
  const bytes = fs.readFileSync(file);
  return { schema: 1, version: "3.2.2.0", contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    resourceLayoutHash: "a".repeat(64), size: bytes.length, resourceCount: 300,
    capabilities: Object.fromEntries(Models.CAPABILITIES.map(key => [key, { compatible: true, reason: "" }])) };
}
test("explicit discovery handles Steam libraries, CrossOver paths, duplicates and manual-only nonstandard locations", async t => {
  const home = fixture(t), steam = path.join(home, "Library/Application Support/Steam");
  const native = dll(path.join(steam, "steamapps/common/Lossless Scaling"));
  const depot = dll(path.join(steam, "steamapps/content/app_993090/depot_993091"), 68);
  const clientRoots = [path.join(steam, "Steam.AppBundle/Steam/Contents/MacOS")];
  const clientDepot = dll(path.join(clientRoots[0], "steamapps/content/app_993090/depot_993091"), 70);
  dll(path.join(steam, "steamapps/content/app_123456/depot_123457"), 69);
  const extra = path.join(home, 'External "Steam"'), external = dll(path.join(extra, "steamapps/common/Lossless Scaling"), 66);
  const vdf = text => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  fs.writeFileSync(path.join(steam, "steamapps/libraryfolders.vdf"), `"libraryfolders" { "0" { "path" "${vdf(steam)}" } "1" { "path" "${vdf(extra)}" } }`);
  const drive = path.join(home, "Library/Application Support/CrossOver/Bottles/Steam bottle/drive_c");
  const wineSteam = path.join(drive, "Program Files (x86)/Steam"), cross = dll(path.join(wineSteam, "steamapps/common/Lossless Scaling"));
  const secondary = dll(path.join(drive, "Games/steamapps/common/Lossless Scaling"), 67);
  fs.writeFileSync(path.join(wineSteam, "steamapps/libraryfolders.vdf"), '"libraryfolders" { "1" { "path" "C:\\\\Games" } }');
  dll(path.join(home, "Unrelated"));
  assert.deepEqual(new Set(Sources.findModels({ home, clientRoots })), new Set([native, depot, clientDepot, external, cross, secondary].map(file => fs.realpathSync(file))));
  t.mock.method(globalThis, "fetch", () => assert.fail("discovery stays offline"));
  const context = { home, clientRoots, userDataDir: path.join(home, "profile"), inspect, setupActionId: "findInstalled" };
  let settings = {};
  await runRuntimeManagerAction({ manager: Manager, action: "setup", userDataDir: context.userDataDir, payload: context,
    readSettings: () => settings, saveSettings: value => { settings = value; } });
  const installs = Models.listInstalled(context.userDataDir);
  // Imported models stay automatic until a default is chosen explicitly.
  assert.equal(installs.length, 5); assert.ok(!settings.defaultVersion);
  const explicit = installs[2].version; settings.defaultVersion = explicit;
  await runRuntimeManagerAction({ manager: Manager, action: "setup", userDataDir: context.userDataDir, payload: context,
    readSettings: () => settings, saveSettings: value => { settings = value; } });
  assert.equal(settings.defaultVersion, explicit);
  assert.equal(new Set(installs.map(item => item.versionLabel)).size, 5, "distinct DLL versions need distinguishable labels");
  for (const file of [native, depot, clientDepot, external, cross, secondary]) assert.ok(fs.existsSync(file));
});
test("empty discovery is actionable and never downloads or changes defaults", async t => {
  const home = fixture(t); await assert.rejects(Sources.importFound({ home, clientRoots: [] }), /Import.*Download from Steam/);
});
// A managed SteamCMD package is accepted only with Valve's Developer ID signature on its executable.
function steamcmdPackage(t, { executable = true } = {}) {
  const root = fixture(t), unpacked = path.join(root, "unpacked"), bytes = Buffer.from("steamcmd_osx");
  fs.mkdirSync(unpacked);
  if (executable) fs.writeFileSync(path.join(unpacked, "steamcmd"), Buffer.alloc(64), { mode: 0o755 });
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), url = SteamCMDSource.location.replace(/steam_cmd_osx$/, "steamcmd_osx.zip." + "0".repeat(40));
  const part = { filename: "steamcmd_osx.zip", url, bytes: bytes.length, sha256, bootstrap: true };
  return { unpacked, pin: { version: "1794537082", parts: [part], asset: { url, sha256 } } };
}
test("an updated SteamCMD package is accepted by Valve's Developer ID signature", async t => {
  const { unpacked, pin } = steamcmdPackage(t), calls = [];
  t.mock.method(DeveloperId, "verifyDeveloperId", async (file, team) => { calls.push([file, team]); return { teamIdentifier: team }; });
  assert.deepEqual(await SteamCMDSource.prepare({ unpacked, pin }), { publisherVersion: pin.version });
  assert.deepEqual(calls, [[path.join(unpacked, "steamcmd"), "MXGJJ98X76"]]);
  assert.match(DeveloperId.requirement("MXGJJ98X76"), /^anchor apple generic and .*certificate leaf\[subject\.OU\] = "MXGJJ98X76"$/);
});
test("a SteamCMD package without Valve's signed executable is refused and Steam sign-in never starts", async t => {
  for (const options of [{ signed: false }, { executable: false }]) {
    const { unpacked, pin } = steamcmdPackage(t, options);
    const signer = t.mock.method(DeveloperId, "verifyDeveloperId", async () => { throw new Error("not signed by Valve"); });
    await assert.rejects(SteamCMDSource.prepare({ unpacked, pin }), options.executable === false ? /SteamCMD executable|ENOENT/ : /not signed by Valve/);
    assert.equal(signer.mock.callCount(), options.executable === false ? 0 : 1);
    signer.mock.restore();
  }
  const userDataDir = fixture(t);
  const manager = { id: "steamcmd", resolveSelection: () => ({ ready: false, version: "1794537082" }),
    installRuntime: async () => { throw new Error("The downloaded code is not validly signed by Developer ID team MXGJJ98X76."); } };
  await assert.rejects(Steam.acquire({ userDataDir, confirmRuntimeInstall: async () => true }, {
    manager, authenticate: async () => assert.fail("must not authenticate") }), /Developer ID team MXGJJ98X76/);
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, "runtimes/lossless-steam")), []);
});
test("Terminal script passes only the account name, quotes paths, and uses a foreground SteamCMD job", t => {
  const root = fixture(t), session = path.join(root, "space ' and $(no-command)");
  const text = Steam.terminalScript(session), script = path.join(root, "download.command"); fs.writeFileSync(script, text);
  require("node:child_process").execFileSync("/bin/bash", ["-n", script]);
  assert.match(text, /\+force_install_dir.*\+login "\$steam_account" \+app_update 993090 validate \+quit/);
  assert.match(text, /sSteamCmdForcePlatformType windows/); assert.match(text, /fg %2/);
  assert.doesNotMatch(text, /read.*password|\+login anonymous/);
  assert.match(text, /kill -KILL -- "-\$steam_pid"/);
  // Only the signed executable runs, with Valve's bootstrap options and no updater restart loop.
  assert.ok(text.includes(`"$steamcmd" ${SteamCMDSource.BOOTSTRAP_ARGUMENTS.join(" ")} +@sSteamCmdForcePlatformType`));
  assert.doesNotMatch(text, /-eq 42/);
  assert.doesNotMatch(text, /tools\/steamcmd\.sh/);
});
test("Terminal authentication completion and cancellation remove the active session marker", async t => {
  const root = fixture(t);
  for (const cancel of [false, true]) {
    const session = path.join(root, String(cancel)); fs.mkdirSync(session);
    const controller = new AbortController();
    const promise = Steam.terminalDownload(session, { signal: controller.signal, execute: async (command, args) => {
      assert.equal(command, "/usr/bin/open"); assert.deepEqual(args.slice(0, 2), ["-a", "Terminal"]);
      if (cancel) controller.abort(); else fs.writeFileSync(path.join(session, "result"), "0");
    } });
    if (cancel) await assert.rejects(promise, { name: "AbortError" }); else await promise;
    assert.equal(fs.existsSync(path.join(session, "active")), false); assert.ok(fs.existsSync(path.join(session, "cancel")));
  }
});
