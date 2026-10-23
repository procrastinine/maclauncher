const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { launchScript } = require("../src/modules/shared/runtime/launch-script");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renpy-launch-script-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("disabled Ren'Py effects preserve the original script, arguments and options", async () => {
  const args = ["game", "run"], options = { cwd: "/game", env: { RENPY_PLATFORM: "mac-arm64" } };
  const context = { getGameEffectsEnvironment: async () => ({}), spawnDetachedChecked: (...values) => values };
  assert.deepEqual(await launchScript("/publisher/renpy.sh", args, options, true, context), ["/publisher/renpy.sh", args, options, true]);
});

test("Ren'Py shell transport keeps publisher interpreter, $0, arguments, cwd and literal environment values", async t => {
  const root = fixture(t), script = path.join(root, "Publisher ' $(literal).sh");
  const source = '#!/bin/bash\nprintf "%s\\0" "$0" "$@" "$PWD" "$BASH_VERSION" "$DYLD_LIBRARY_PATH" "$SteamAppId"\n';
  fs.writeFileSync(script, source, { mode: 0o755 });
  const args = ["game with spaces", "run", "'quoted'", "$(touch forbidden)", ""], literal = "'\"$(touch forbidden)`noop`; $HOME";
  const effects = { DYLD_INSERT_LIBRARIES: "/unused/effects.dylib", RESHADE_CONFIG_PATH: "/owned/config.json" };
  let received;
  const context = {
    getGameEffectsEnvironment: async () => effects,
    applyGameEnvironment: async base => ({ ...base, ...effects }),
    spawnDetachedChecked: (command, parameters, options) => {
      received = { command, parameters, options };
      return spawnSync(command, parameters, { ...options, encoding: "utf8" });
    }
  };
  const result = await launchScript(script, args, { cwd: root, env: { ...process.env, DYLD_LIBRARY_PATH: literal, SteamAppId: "123" } }, false, context);
  assert.equal(result.status, 0, result.stderr);
  const fields = result.stdout.split("\0");
  assert.deepEqual(fields.slice(0, 1 + args.length), [script, ...args]);
  assert.equal(fs.realpathSync(fields[1 + args.length]), fs.realpathSync(root));
  assert.match(fields[2 + args.length], /^\d+\.\d+/);
  assert.deepEqual(fields.slice(3 + args.length), [literal, "123", ""]);
  assert.equal(received.command, "/bin/bash");
  assert.equal(received.options.env.RESHADE_CONFIG_PATH, "/owned/config.json");
  assert.equal(fs.readFileSync(script, "utf8"), source);
  assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
});

test("macOS native injection survives the protected Ren'Py shell without editing the publisher script", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), script = path.join(root, "publisher.sh"), marker = path.join(root, "marker.dylib"), probe = path.join(root, "probe");
  fs.writeFileSync(path.join(root, "marker.c"), 'int maclauncher_test_marker(void) { return 47; }\n');
  fs.writeFileSync(path.join(root, "probe.c"), '#include <dlfcn.h>\n#include <stdlib.h>\nint main(void) { return dlsym(RTLD_DEFAULT,"maclauncher_test_marker") && getenv("DYLD_INSERT_LIBRARIES") ? 0 : 42; }\n');
  for (const args of [["-dynamiclib", path.join(root, "marker.c"), "-o", marker], [path.join(root, "probe.c"), "-o", probe]]) {
    const build = spawnSync("/usr/bin/cc", args, { encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
  }
  const source = '#!/bin/sh\nexec "$@"\n';
  fs.writeFileSync(script, source, { mode: 0o755 });
  const effects = { DYLD_INSERT_LIBRARIES: marker }, env = { ...process.env, ...effects };
  assert.equal(spawnSync(probe, [], { env }).status, 0);
  assert.equal(spawnSync(script, [probe], { env }).status, 42, "protected system shell strips the original injection environment");
  const result = await launchScript(script, [probe], { cwd: root, env }, false, {
    getGameEffectsEnvironment: async () => effects,
    applyGameEnvironment: async base => ({ ...base, ...effects }),
    spawnDetachedChecked: (command, args, options) => spawnSync(command, args, { ...options, encoding: "utf8" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(script, "utf8"), source);
});

test("script launch forwards the selected process architecture before graphics and protected-shell restoration", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-graphics-architecture-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const script = path.join(root, "publisher.sh");fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
  const calls = [], effects = {DYLD_INSERT_LIBRARIES: "/included/universal.dylib"};
  const context = {
    getGameEffectsEnvironment: async request => {calls.push(["prepare", request]);return effects;},
    applyGameEnvironment: async (environment, request) => {calls.push(["merge", request]);return {...environment, ...effects};},
    spawnDetachedChecked: (...args) => {calls.push(["spawn", args[3]]);return {pid: 1};}
  };
  await launchScript(script, [], {env: {}}, true, context);
  assert.deepEqual(calls, [["prepare", {needsRosetta: true}], ["merge", {needsRosetta: true}], ["spawn", true]]);
});
