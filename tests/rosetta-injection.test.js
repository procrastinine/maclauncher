const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createProcessLauncher } = require("../src/core/processes");
const Sikarugir = require("../src/modules/crossover/sikarugir/launch");
const CrossOver = require("../src/modules/crossover/runtime/launch");

// These fixtures exercise dyld, SIP's arch/shell environment handling, child
// inheritance, and real Rosetta execution without opening a window or GPU.
const program = `
#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
extern char **environ;
int main(int argc,char **argv) {
  int translated=0;size_t size=sizeof translated;
  if(sysctlbyname("sysctl.proc_translated",&translated,&size,NULL,0)) {perror("sysctl.proc_translated");return 14;}
  int (*marker)(void)=dlsym(RTLD_DEFAULT,"maclauncher_injection_marker");
  const char *loaded=getenv("DYLD_INSERT_LIBRARIES"),*expected=getenv("EXPECTED_DYLD");
  int retained=loaded&&expected&&!strcmp(loaded,expected);
  const char *architecture=
#if defined(__x86_64__)
    "x86_64";
#else
    "arm64";
#endif
  if(strstr(argv[0],"server")) {
    FILE *report=fopen(getenv("SERVER_REPORT"),"w");
    if(!report)return 11;
    fprintf(report,"{\\"injected\\":%d,\\"environmentRetained\\":%d}",marker?marker():0,retained);
    fclose(report);return 0;
  }
  printf("{\\"architecture\\":\\"%s\\",\\"translated\\":%d,\\"injected\\":%d,\\"environmentRetained\\":%d,\\"child\\":%d}\\n",architecture,translated,marker?marker():0,retained,argc>1&&!strcmp(argv[1],"--child"));
  fflush(stdout);
  if(argc>1&&strcmp(argv[1],"--child")) {
    pid_t child;char *args[]={argv[1],"--child",NULL};
    if(posix_spawn(&child,args[0],NULL,NULL,args,environ))return 12;
    int status=0;if(waitpid(child,&status,0)<0||!WIFEXITED(status))return 13;
    return WEXITSTATUS(status);
  }
  return 0;
}`;

test("real Intel and universal launches retain injected libraries under Rosetta and in child processes", {
  skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 30000
}, async t => {
  if (spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]).status !== 0) return t.skip("Rosetta is not installed");
  if (spawnSync("/usr/bin/xcrun", ["--find", "clang"]).status !== 0) return t.skip("Apple command-line tools are not installed");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rosetta-injection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "probe.c"), librarySource = path.join(root, "marker.c");
  fs.writeFileSync(source, program);
  fs.writeFileSync(librarySource, "int maclauncher_injection_marker(void) { return 73; }\n");
  const library = path.join(root, "effect; $(literal) 'quoted'.dylib"), intel = path.join(root, "intel"), universal = path.join(root, "universal");
  function compile(args) {
    const result = spawnSync("/usr/bin/xcrun", ["clang", ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  compile(["-arch", "arm64", "-arch", "x86_64", "-dynamiclib", librarySource, "-o", library]);
  compile(["-arch", "x86_64", source, "-o", intel]);
  compile(["-arch", "arm64", "-arch", "x86_64", source, "-o", universal]);
  const env = { ...process.env, DYLD_INSERT_LIBRARIES: library, EXPECTED_DYLD: library };
  const launcher = createProcessLauncher();
  async function capture(command, args, environment, forceIntel = false) {
    const child = await launcher.spawnDetachedChecked(command, args, { detached: false,
      stdio: ["ignore", "pipe", "pipe"], env: environment }, forceIntel);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    return stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  for (const [label, command, forceIntel] of [["thin Intel", intel, false], ["universal forced Intel", universal, true]]) {
    await t.test(label, async () => {
      const records = await capture(command, [intel], env, forceIntel);
      assert.equal(records.length, 2);
      for (const [index, record] of records.entries()) assert.deepEqual(record,
        { architecture: "x86_64", translated: 1, injected: 73, environmentRetained: 1, child: index });
    });
  }
  await t.test("Sikarugir shell restores injection for Intel game and child, keeping wineserver clean", async () => {
    const server = path.join(root, "server"), report = path.join(root, "server.json");
    fs.copyFileSync(intel, server);
    const environment = { ...env, SERVER_REPORT: report };
    const records = await capture("/bin/sh", Sikarugir.supervisorArguments(intel, server, "play", [intel], environment), environment);
    assert.equal(records.length, 2);
    for (const [index, record] of records.entries()) assert.deepEqual(record,
      { architecture: "x86_64", translated: 1, injected: 73, environmentRetained: 1, child: index });
    assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { injected: 0, environmentRetained: 0 });
  });
  await t.test("CrossOver's Perl shellwords format restores literal injection paths before Intel exec", async () => {
    // Use the same Apple Perl interpreter and parser as CrossOver's wrapper.
    // Both are SIP protected, so only the explicit --env data survives entry.
    const restore = 'use Text::ParseWords; for my $item (shellwords(shift @ARGV)) { my ($key,$value)=split /=/,$item,2; $ENV{$key}=$value; } exec {$ARGV[0]} @ARGV; die $!;';
    const serialized = CrossOver.wineEnvironmentString({ DYLD_INSERT_LIBRARIES: library, EXPECTED_DYLD: library });
    const records = await capture("/usr/bin/perl", ["-e", restore, serialized, intel, intel], env);
    assert.equal(records.length, 2);
    for (const [index, record] of records.entries()) assert.deepEqual(record,
      { architecture: "x86_64", translated: 1, injected: 73, environmentRetained: 1, child: index });
  });
});
