// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Sources = require("../src/modules/shared/reshade/model-sources");
const Steam = require("../src/modules/shared/reshade/steam-models");
const Models = require("../src/modules/shared/reshade/models");
const Manager = require("../src/modules/shared/reshade/runtime/models-manager");
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
  assert.equal(installs.length, 5); assert.ok(settings.defaultVersion);
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
// tar materializes a SteamCMD executable; codesign reports the vendor signature check.
function steamcmdRunner(calls, { signed = true, executable = true } = {}) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/tar" && executable) {
      const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(2, 12);
      fs.writeFileSync(path.join(args[3], "steamcmd"), bytes, { mode: 0o755 }); fs.writeFileSync(path.join(args[3], "steamcmd.sh"), "#!/bin/sh\n");
    } else if (command === "/usr/bin/codesign" && !signed) throw Object.assign(new Error("test-requirement: code failed to satisfy specified code requirement(s)"), { code: 3 });
    else if (!["/usr/bin/tar", "/usr/bin/codesign"].includes(command)) assert.fail(`unexpected execution of ${command}`);
    return { stdout: "", stderr: "" };
  };
}
test("an updated SteamCMD download is accepted by Valve's Developer ID signature", async t => {
  const userDataDir = fixture(t), calls = [];
  Harness.network.routes = { [Steam.BOOTSTRAP.location]: Buffer.from("updated vendor bootstrap") }; t.after(() => { Harness.network.routes = null; });
  const result = await Steam.acquire({ userDataDir }, {
    execute: steamcmdRunner(calls), authenticate: async session => {
      assert.deepEqual(calls.map(call => call[0]), ["/usr/bin/tar", "/usr/bin/codesign"]);
      assert.deepEqual(calls[1].slice(1, 3), ["--verify", "--strict"]);
      assert.match(calls[1][3], /^-R=anchor apple generic and .*certificate leaf\[subject\.OU\] = "MXGJJ98X76"$/);
      assert.equal(calls[1][4], path.join(session, "tools/steamcmd"));
      dll(path.join(session, "content"));
    }, importModel: async () => ({ version: "3.2.2.0" }) });
  assert.equal(result.version, "3.2.2.0"); assert.deepEqual(fs.readdirSync(path.join(userDataDir, "runtimes/lossless-steam")), []);
});
test("a SteamCMD download without Valve's signed executable prevents sign-in and cleans temporary files", async t => {
  const userDataDir = fixture(t);
  Harness.network.routes = { [Steam.BOOTSTRAP.location]: Buffer.from("changed") }; t.after(() => { Harness.network.routes = null; });
  for (const options of [{ signed: false }, { executable: false }]) {
    const calls = [];
    await assert.rejects(Steam.acquire({ userDataDir }, {
      execute: steamcmdRunner(calls, options), authenticate: async () => assert.fail("must not authenticate") }), /not Valve's signed macOS SteamCMD/);
    assert.deepEqual(calls.map(call => call[0]), options.signed === false ? ["/usr/bin/tar", "/usr/bin/codesign"] : ["/usr/bin/tar"]);
    assert.deepEqual(fs.readdirSync(path.join(userDataDir, "runtimes/lossless-steam")), []);
  }
});
test("Terminal script passes only the account name, quotes paths, and uses a foreground SteamCMD job", t => {
  const root = fixture(t), session = path.join(root, "space ' and $(no-command)");
  const text = Steam.terminalScript(session), script = path.join(root, "download.command"); fs.writeFileSync(script, text);
  require("node:child_process").execFileSync("/bin/bash", ["-n", script]);
  assert.match(text, /\+force_install_dir.*\+login "\$steam_account" \+app_update 993090 validate \+quit/);
  assert.match(text, /sSteamCmdForcePlatformType windows/); assert.match(text, /fg %2/);
  assert.doesNotMatch(text, /read.*password|\+login anonymous/);
  assert.match(text, /kill -KILL -- "-\$steam_pid"/);
  // Only the signed executable runs; the archive's unsigned shell launcher does not.
  assert.match(text, /"\$steamcmd" \+@sSteamCmdForcePlatformType/); assert.match(text, /-eq 42/);
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
