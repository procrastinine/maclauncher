const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Client = require("../src/modules/shared/reshade/steam-client-models");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-steam-client-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const steam = path.join(home, "Library/Application Support/Steam"), log = path.join(steam, "logs/console_log.txt");
  const root = path.join(steam, "Steam.AppBundle/Steam/Contents/MacOS");
  const directory = path.join(root, "steamapps/content/app_993090/depot_993091");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.dirname(log), { recursive: true });
  const executable = path.join(root, "steam_osx"); fs.writeFileSync(executable, "", { mode: 0o700 });
  fs.writeFileSync(log, `Depot download complete : "${directory}" (manifest old)\n`);
  fs.writeFileSync(path.join(directory, "Lossless.dll"), "existing copy");
  return { home, steam, log, root, directory, executable };
}
test("Mac Steam reuses its client, waits for a fresh completion and imports only the requested depot", async t => {
  const f = fixture(t); assert.equal(Client.findClient({ roots: [f.root] }), f.executable);
  let imported = false;
  const result = await Client.acquire({ home: f.home, userDataDir: path.join(f.home, "profile") }, {
    executable: f.executable, timeout: 1000, pollInterval: 5,
    execute: async (executable, args) => {
      assert.equal(executable, f.executable);
      assert.deepEqual(args, ["-console", "+download_depot", "993090", "993091"]);
      fs.appendFileSync(f.log, 'Depot download complete : "/unrelated/depot_993091"\nDownloading depot 993091 (481 files, 54 MB) ...\n');
      const timer = setTimeout(() => {
        fs.appendFileSync(f.log, `Depot download complete : "${f.directory.replaceAll(path.sep, "\\")}" (manifest new)\n`);
      }, 20); t.after(() => clearTimeout(timer));
    },
    importModel: async options => {
      imported = true; assert.equal(options.runtimePath, path.join(f.directory, "Lossless.dll"));
      assert.equal(options.userDataDir, path.join(f.home, "profile")); return { version: "verified" };
    }
  });
  assert.equal(imported, true); assert.equal(result.version, "verified");
  assert.match(result.message, /Steam for Mac/); assert.ok(fs.existsSync(path.join(f.directory, "Lossless.dll")));
});
test("Mac Steam never treats an old depot or completion as a successful new download", async t => {
  const f = fixture(t);
  await assert.rejects(Client.acquire({ home: f.home }, {
    executable: f.executable, timeout: 25, pollInterval: 5, execute: async () => {},
    importModel: async () => assert.fail("stale files must not be imported")
  }), /did not complete/);
});
test("Steam sign-in/download failure is actionable and cancellation preserves Steam-owned files", async t => {
  const f = fixture(t);
  await assert.rejects(Client.acquire({ home: f.home }, {
    executable: f.executable, timeout: 100, pollInterval: 5,
    execute: async () => fs.appendFileSync(f.log, "Depot download failed : Missing license\n"),
    importModel: async () => assert.fail("failed download must not be imported")
  }), /account ownership/);
  const controller = new AbortController();
  await assert.rejects(Client.acquire({ home: f.home, signal: controller.signal }, {
    executable: f.executable, execute: async () => controller.abort(),
    importModel: async () => assert.fail("cancelled download must not be imported")
  }), { name: "AbortError" });
  assert.ok(fs.existsSync(f.executable)); assert.ok(fs.existsSync(path.join(f.directory, "Lossless.dll")));
});
test("the download action prefers Mac Steam and retains an explicit SteamCMD alternative", async t => {
  const Manager = require("../src/modules/shared/reshade/runtime/models-manager");
  const SteamCMD = require("../src/modules/shared/reshade/steam-models");
  const client = t.mock.method(Client, "findClient", () => "/Applications/Steam.app/Contents/MacOS/steam_osx");
  t.mock.method(Client, "downloadWithClient", async () => "client");
  t.mock.method(SteamCMD, "downloadFromSteam", async () => "steamcmd");
  assert.equal(await Manager.performSetupAction({ setupActionId: "downloadSteam" }), "client");
  assert.equal(await Manager.performSetupAction({ setupActionId: "downloadSteamCMD" }), "steamcmd");
  client.mock.mockImplementation(() => null);
  assert.equal(await Manager.performSetupAction({ setupActionId: "downloadSteam" }), "steamcmd");
});
