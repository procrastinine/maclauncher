const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("fixed native API hosts retain literal trailing process arguments and their required API inputs", t => {
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
  const siglus = require("../src/modules/siglus/runtime/profile").hostResource();
  const Python = require("../src/modules/shared/runtime/python");
  const python = Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
  assert.ok(python, "the included Python runtime is required by RFVP");
  const launches = [
    { command: siglus, args: ["--probe", library, root, "utf8", "--", ...gameArguments], encoding: "utf8" },
    { command: siglus, args: ["--probe", library, root, "--", ...gameArguments], encoding: "(null)" },
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
