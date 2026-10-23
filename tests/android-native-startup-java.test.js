const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("./helpers/android-java");
const { encodeEnvironment } = require("../src/modules/android/native-startup");

test("compiled Android startup decoder and process getters preserve the launcher protocol and private identities", t => {
  const java = process.env.JAVA_HOME, host = process.env.KLEPTON_NATIVE_STARTUP_HOST_JAR;
  if (!java || !host) return t.skip("Requires Java21 and KLEPTON_NATIVE_STARTUP_HOST_JAR");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-native-startup-java-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root + path.sep,
    KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT: encodeEnvironment({ EMPTY: "", HOME: "/guest/home", LANG: "é 🧩", LINE: "first\nnext=value", PATH: "/usr/bin:/bin" }),
    ANDROID_STARTUP_TEST_SECRET: "synthetic-secret", KL_TEST_CONTROL: "synthetic-control", MACLAUNCHER_TEST_IDENTITY: "synthetic-identity" };
  const pids = [];
  const run = (command, args) => {
    const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 20000, maxBuffer: 1 << 20 });
    const output = (result.stdout || "") + (result.stderr || "");
    assert.ifError(result.error);
    assert.equal(result.signal, null, output);
    assert.equal(result.status, 0, output);
    pids.push(result.pid);
    return output;
  };
  const fixture = path.join(__dirname, "fixtures/android-native/startup/StartupEnvironmentProbe.java");
  run(path.join(java, "bin/javac"), ["--release", "21", "-encoding", "UTF-8", "-implicit:none", "-cp", path.resolve(host), "-d", root, fixture]);
  const output = run(path.join(java, "bin/java"), ["-Xverify:all", "-cp", root + path.delimiter + path.resolve(host),
    "maclauncher.android.framework.StartupEnvironmentProbe", path.resolve(host), "--host-only-fixture-argument"]);
  assert.match(output, /PASS actual startup decoder: \d+ checks; cached environment clones; configured process argv/);
  const retired = spawnSync("/bin/ps", ["-p", pids.join(","), "-o", "pid=,comm="], { encoding: "utf8" });
  assert.ifError(retired.error);
  assert.equal(retired.status, 1, retired.stdout + retired.stderr);
  assert.equal(retired.stdout.trim(), "");
  t.diagnostic(output.trim());
  t.diagnostic("javac/java exited0 and exact PIDs absent: " + pids.join(","));
});
