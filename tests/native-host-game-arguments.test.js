const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("Siglus and RealLive forward literal process arguments through the selected managed host", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-host-arguments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const Module = require("../src/modules/siglus/main"), Detect = require("../src/modules/siglus/detect");
  const install = { executablePath: "/managed/bin/siglus-host", libraryPath: "/managed/lib/libsiglus.dylib", needsRosetta: false };
  t.mock.method(Module.runtimeManagers[0], "resolveSelection", () => ({ ready: true, install }));
  let engineKind;
  t.mock.method(Detect, "inspectGame", () => ({ engineKind, interpreterSupported: true }));
  const gameArguments = ["--title", "  A quoted game  ", "", "$(touch unexpected)", "first\nsecond"];
  for (engineKind of ["siglus", "reallive"]) {
    const game = path.join(root, engineKind); fs.mkdirSync(game); fs.writeFileSync(path.join(game, "original.dat"), "original bytes");
    const calls = [], entry = { gameId: engineKind, gamePath: game };
    const result = await Module.launchRuntime("siglus", entry, { userDataDir: path.join(root, "profile"), runtimeSettings: { encoding: "utf8" }, settings: {}, gameArguments,
      spawnDetachedChecked: (...args) => { calls.push(args); return { pid: 123 }; } });
    assert.equal(result.pid, 123); assert.equal(calls[0][0], install.executablePath);
    const preparedRoot = engineKind === "siglus" ? path.join(root, "profile/games/siglus/modules/siglus/project") : game;
    assert.deepEqual(calls[0][1], ["--run", install.libraryPath, preparedRoot, ...(engineKind === "siglus" ? [] : ["utf8"]), "--", ...gameArguments]);
    assert.equal(fs.readFileSync(path.join(game, "original.dat"), "utf8"), "original bytes");
    assert.equal(fs.existsSync(path.join(root, "unexpected")), false);
  }
});

test("the RFVP native API host retains literal trailing process arguments and its required API inputs", t => {
  if (process.platform !== "darwin") return t.skip("macOS native host APIs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-host-arguments-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.c"), library = path.join(root, "fixture.dylib");
  fs.writeFileSync(source, `#include <crt_externs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void record(const char *root,const char *encoding) {
  FILE *out=fopen(getenv("GAME_ARGUMENT_MARKER"),"wb");
  const char *values[]={root,encoding?encoding:"(null)"};
  for(int i=0;i<2;i++) fwrite(values[i],1,strlen(values[i])+1,out);
  char **argv=*_NSGetArgv();
  for(int i=0;i<*_NSGetArgc();i++) fwrite(argv[i],1,strlen(argv[i])+1,out);
  fclose(out);
}
int rfvp_run_entry(const char *root,const char *encoding) {record(root,encoding);return 0;}
void rfvp_set_text_hidpi_enabled(int enabled) {(void)enabled;}
char *game_probe_json(const char *root,const char *encoding,const char *unused) {record(root,encoding);return strdup("{}");}
void game_string_free(char *value) {free(value);}
int game_run_entry(const char *root,const char *encoding) {record(root,encoding);return 0;}
`);
  const compiled = spawnSync("/usr/bin/clang", ["-dynamiclib", "-mmacosx-version-min=13.0", source, "-o", library], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const gameArguments = ["--title", "  A quoted game  ", "", "$(touch unexpected)", "first\nsecond"];
  const Python = require("../src/modules/shared/runtime/python");
  const python = Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
  assert.ok(python, "the included Python runtime is required by RFVP");
  const launches = [
    { command: python, args: ["-I", "-u", require.resolve("../src/modules/fvp/host.py"), library, root, "utf8", "1", ...gameArguments], encoding: "utf8" }
  ];
  for (const [index, launch] of launches.entries()) {
    const marker = path.join(root, `arguments-${index}`);
    const result = spawnSync(launch.command, launch.args, { encoding: "utf8", timeout: 10000,
      env: { ...process.env, GAME_ARGUMENT_MARKER: marker } });
    assert.equal(result.status, 0, result.stderr);
    const values = fs.readFileSync(marker, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(values.slice(0, 2), [root, launch.encoding]);
    assert.deepEqual(values.slice(-gameArguments.length), gameArguments);
    assert.equal(fs.existsSync(path.join(root, "unexpected")), false);
  }
});
