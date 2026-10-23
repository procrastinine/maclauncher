const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const test = require("node:test");
const { spawnDetachedChecked } = require("../src/core/processes");

test("macOS policy blocks native IP sockets and children, preserves Unix IPC and injected libraries", {
  skip: process.platform !== "darwin", timeout: 20000
}, async t => {
  const root = fs.mkdtempSync("/tmp/maclauncher-net-");
  const servers = [], children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const name of ["home", "tmp", "cache"]) fs.mkdirSync(path.join(root, name));
  const probe = path.join(root, "probe"), library = path.join(root, "inject.dylib");
  const source = path.join(__dirname, "fixtures/network-isolation/probe.c");
  for (const extra of [[], ["-DDYLD_PROBE", "-dynamiclib"]]) execFileSync("/usr/bin/xcrun", ["clang",
    "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0", ...extra, source,
    "-o", extra.length ? library : probe], { timeout: 10000, stdio: "pipe" });
  for (let i = 0; i < 2; i++) {
    const server = net.createServer(client => client.end()); servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    await new Promise((resolve, reject) => {
      const client = net.connect(server.address().port, "127.0.0.1");
      client.once("connect", () => { client.destroy(); resolve(); }); client.once("error", reject);
    });
  }
  const env = { PATH: "/usr/bin:/bin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "cache"), DYLD_INSERT_LIBRARIES: library,
    DYLD_PROBE_LITERAL: "spaces $(must-not-run) `nor-this` ; = quoted" };
  for (const asset of [false, true]) {
    const child = await spawnDetachedChecked(probe, [String(servers[0].address().port),
      String(servers[1].address().port), asset ? "1" : "0", root, "parent"],
    { cwd: root, env, networkIsolation: true, networkAssetPort: asset ? servers[0].address().port : undefined,
      stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.push(child);
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.equal(output.split("passed").length - 1, 2, output);
  }
});
