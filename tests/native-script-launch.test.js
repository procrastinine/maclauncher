const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createLauncher } = require("../src/core/launcher");
const ReShade = require("../src/modules/shared/reshade");
const Script = require("../src/modules/shared/runtime/launch-script");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-native-script-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(ReShade, "prepare", async () => ({}));
  return root;
}

test("ordinary import and Play run non-executable scripts with their own cwd and source intact", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), published = [];
  const launcher = createLauncher({ userDataDir: path.join(root, "profile"),
    onGameProcessSpawn: (_entry, child) => published.push(child) });
  for (const [extension, header] of [[".sh", ""], [".command", "#!/bin/sh\n"], [".bash", "#!/usr/bin/env -S bash -eu\n"], [".zsh", "#!/bin/zsh\n"]]) {
    const script = path.join(root, "Game ' $(literal)" + extension);
    const source = header + 'printf "%s\\n%s\\n" "$0" "$PWD" > result.txt\nprintf "%s\\0" "$@" > args.bin\nexit 7\n';
    fs.writeFileSync(script, source, { mode: 0o644 });
    const entry = await launcher.resolveEntry(script, { runtimeId: "native" });
    entry.launchArguments = '--windowed "A B" "" \'$(touch forbidden)\'';
    assert.equal(entry.moduleId, "generic-app");
    const result = await launcher.launchEntry(entry, { runtimeId: "native", strict: true, autoInstallRuntime: false });
    assert.equal(result.runtimeId, "native");
    assert.equal(result.child, published.at(-1), "Playing and the result share one process lifetime");
    if (result.child.exitCode == null) await once(result.child, "close");
    assert.equal(result.child.exitCode, 7);
    const [actualScript, cwd] = fs.readFileSync(path.join(root, "result.txt"), "utf8").trimEnd().split("\n");
    assert.equal(actualScript, script);
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(root));
    assert.equal(fs.readFileSync(script, "utf8"), source);
    assert.equal(fs.statSync(script).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(path.join(root, "literal")), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "args.bin"), "utf8").split("\0"), ["--windowed", "A B", "", "$(touch forbidden)", ""]);
    assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
  }
});

test("Play keeps the background game's session active after the script returns", { skip: process.platform !== "darwin", timeout: 5000 }, async t => {
  const root = fixture(t), script = path.join(root, "Background.sh");
  fs.writeFileSync(script, "#!/bin/sh\nsleep 0.4 &\nexit 0\n");
  const launcher = createLauncher({ userDataDir: path.join(root, "profile") });
  const result = await launcher.launchEntry(await launcher.resolveEntry(script), { autoInstallRuntime: false });
  t.after(() => result.child.kill("SIGKILL"));
  assert.equal(result.child.exitCode, null);
  const ended = once(result.child, "close");
  assert.equal(result.child.kill("SIGTERM"), true);
  await ended;
});

test("app bundles receive the same game-level arguments as scripts and bare binaries", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), app = path.join(root, "Game.app"), macos = path.join(app, "Contents/MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>game</string></dict></plist>');
  fs.writeFileSync(path.join(macos, "game"), '#!/bin/sh\nprintf "%s\\0" "$@" > args.bin\n', { mode: 0o755 });
  const launcher = createLauncher({ userDataDir: path.join(root, "profile") });
  const entry = await launcher.resolveEntry(app, { runtimeId: "native" });
  entry.launchArguments = '--name "A B" "" \'$(touch forbidden)\'';
  const result = await launcher.launchEntry(entry, { autoInstallRuntime: false });
  if (result.child.exitCode == null) await once(result.child, "close");
  assert.equal(result.child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(path.join(macos, "args.bin"), "utf8").split("\0"), ["--name", "A B", "", "$(touch forbidden)", ""]);
  assert.equal(fs.existsSync(path.join(macos, "forbidden")), false);
});

test("extensionless Mac executables import, launch with shared graphics, and export as custom commands", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), executable = path.join(root, "Native game ' $(literal)"), library = path.join(root, "marker.dylib");
  const source = path.join(root, "game.c"), marker = path.join(root, "marker.c");
  fs.writeFileSync(marker, "int maclauncher_bare_marker(void) { return 1; }\n");
  fs.writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <limits.h>
#include <dlfcn.h>
#include <string.h>
int main(int argc, char **argv) {
  char cwd[PATH_MAX];
  FILE *out = fopen("bare-result.txt", "w");
  if (!out || !getcwd(cwd, sizeof(cwd))) return 42;
  fprintf(out, "%s\\n%d\\n%s\\n%s\\n%s\\n", cwd, dlsym(RTLD_DEFAULT, "maclauncher_bare_marker") != NULL,
    getenv("RESHADE_WINDOW_STATE") ?: "unset", getenv("ELECTRON_RUN_AS_NODE") ?: "unset",
    getenv("MACLAUNCHER_GAME_ARGUMENTS") ?: "unset");
  fclose(out);
  out = fopen("args.bin", "wb");
  if (!out) return 43;
  for (int i = 1; i < argc; i++) fwrite(argv[i], 1, strlen(argv[i]) + 1, out);
  fclose(out);
  return 7;
}
`);
  for (const args of [["-dynamiclib", marker, "-o", library], [source, "-o", executable]]) {
    const build = spawnSync("/usr/bin/cc", args, { encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
  }
  t.mock.method(ReShade, "prepare", async (_entry, options) => {
    assert.equal(options.graphicsHost, "window");
    return { DYLD_INSERT_LIBRARIES: library, RESHADE_WINDOW_STATE: "/owned/window-state" };
  });
  const profile = path.join(root, "profile"), published = [];
  const launcher = createLauncher({ userDataDir: profile, onGameProcessSpawn: (_entry, child) => published.push(child) });
  const entry = await launcher.resolveEntry(executable, { runtimeId: "native" });
  entry.launchArguments = '--windowed "A B" "" \'$(touch forbidden)\'';
  launcher.persistEntry(entry);
  assert.equal(entry.moduleId, "generic-app");
  assert.equal(entry.moduleData.launchKind, "executable");
  assert.ok(entry.moduleData.executableArchitectures.includes(process.arch === "x64" ? "x86_64" : process.arch));
  const result = await launcher.launchEntry(entry, { runtimeId: "native", strict: true, autoInstallRuntime: false });
  assert.equal(result.child, published.at(-1));
  if (result.child.exitCode == null) await once(result.child, "close");
  assert.equal(result.child.exitCode, 7);
  const output = path.join(root, "bare-result.txt"), fields = fs.readFileSync(output, "utf8").trimEnd().split("\n");
  assert.equal(fs.realpathSync(fields[0]), fs.realpathSync(root));
  assert.deepEqual(fields.slice(1, 4), ["1", "/owned/window-state", "unset"]);
  const expectedArguments = ["--windowed", "A B", "", "$(touch forbidden)", ""];
  assert.deepEqual(JSON.parse(fields[4]), expectedArguments.slice(0, -1));
  assert.deepEqual(fs.readFileSync(path.join(root, "args.bin"), "utf8").split("\0"), expectedArguments);

  fs.unlinkSync(output);
  fs.unlinkSync(path.join(root, "args.bin"));
  const repoRoot = path.resolve(__dirname, "..");
  const command = require("../src/main/game-command").writeGameCommand(path.join(root, "Play native game"), {
    gamePath: executable, userDataDir: profile, executablePath: process.execPath, repoRoot, packaged: false
  });
  const launched = spawnSync("/bin/zsh", [command], { encoding: "utf8", timeout: 20000 });
  assert.equal(launched.status, 0, launched.stderr);
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const exported = fs.readFileSync(output, "utf8").trimEnd().split("\n");
  assert.equal(fs.realpathSync(exported[0]), fs.realpathSync(root));
  assert.equal(exported[3], "unset");
  assert.deepEqual(JSON.parse(exported[4]), expectedArguments.slice(0, -1));
  assert.deepEqual(fs.readFileSync(path.join(root, "args.bin"), "utf8").split("\0"), expectedArguments);
  assert.equal(fs.existsSync(path.join(root, "literal")), false);
  assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
});

test("env shebangs and plain shell files carry shared graphics settings as literal argv data", async t => {
  const root = fixture(t), library = path.join(root, "effects ' $(literal).dylib");
  if (process.platform === "darwin") {
    const source = path.join(root, "marker.c");
    fs.writeFileSync(source, "int maclauncher_script_marker(void) { return 1; }\n");
    const build = spawnSync("/usr/bin/cc", ["-dynamiclib", source, "-o", library], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
  }
  const effects = { DYLD_INSERT_LIBRARIES: library, RESHADE_WINDOW_STATE: "/owned/window-state" };
  for (const [name, header] of [["plain.sh", ""], ["env.sh", "#!/usr/bin/env bash\n"], ["split.sh", "#!/usr/bin/env -S bash -eu\n"]]) {
    const script = path.join(root, name);
    fs.writeFileSync(script, header + 'printf "%s\\0" "$0" "$@" "$DYLD_INSERT_LIBRARIES" "$RESHADE_WINDOW_STATE"\n');
    const args = ["a ' quoted", "$(touch forbidden)"];
    const result = await Script.launchScript(script, args, { cwd: root, env: process.env }, false, {
      getGameEffectsEnvironment: async () => effects,
      applyGameEnvironment: async base => ({ ...base, ...effects }),
      spawnDetachedChecked: (command, parameters, options) => spawnSync(command, parameters, { ...options, encoding: "utf8" })
    }, { allowUnexecutable: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\0"), [script, ...args, effects.DYLD_INSERT_LIBRARIES, effects.RESHADE_WINDOW_STATE, ""]);
    assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
  }
});
