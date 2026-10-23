const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const { execFileSync, spawn } = require("node:child_process");
const { profile, environment } = require("../src/modules/shared/runtime/macos-sandbox");

test("confined Android/iOS policy actually denies network by default and permits explicit access", {
  skip: process.platform !== "darwin", timeout: 15000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-network-")));
  const servers = [], children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode == null && child.signalCode == null)
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const executable = path.join(root, "probe");
  execFileSync("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/network-isolation/confined-probe.c"), "-o", executable], { timeout: 10000, stdio: "pipe" });
  let connections = 0;
  for (const host of ["127.0.0.1", "::1"]) {
    const server = net.createServer(client => { connections++; client.end(); }); servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  }
  for (const blockNetwork of [true, false]) {
    const policy = path.join(root, blockNetwork ? "blocked.sb" : "allowed.sb");
    fs.writeFileSync(policy, profile({ readDirectories: [], readFiles: [], writeDirectories: [root], executables: [executable], blockNetwork }));
    const before = connections;
    const child = spawn("/usr/bin/sandbox-exec", ["-f", policy, executable,
      ...servers.map(server => String(server.address().port)), blockNetwork ? "0" : "1"], {
      cwd: root, env: { ...environment(), HOME: root, TMPDIR: root }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child); let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.match(output, /confined IPv4\/IPv6 TCP\/UDP and child policy passed/);
    assert.equal(connections - before, blockNetwork ? 0 : 4);
  }
});
