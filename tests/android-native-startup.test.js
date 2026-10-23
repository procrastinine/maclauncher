const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Startup = require("../src/modules/android/native-startup");
const Namespace = require("../src/modules/android/storage-namespace");
const Sandbox = require("../src/modules/android/sandbox");

const variable = "KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT";
function decode(encoded) {
  assert.match(encoded, /^1:[A-Za-z0-9_-]*$/);
  const bytes = Buffer.from(encoded.slice(2), "base64url");
  if (!bytes.length) return [];
  assert.equal(bytes.at(-1), 0);
  return bytes.toString("utf8").slice(0, -1).split("\0");
}

test("native startup encoding preserves explicit empty, Unicode values and deterministic entry boundaries", () => {
  assert.equal(Startup.encodeEnvironment({}), "1:");
  const values = { Z: "=value\nOTHER=inert", A: "é 🧩", EMPTY: "" };
  const encoded = Startup.encodeEnvironment(values);
  assert.deepEqual(decode(encoded), ["A=é 🧩", "EMPTY=", "Z==value\nOTHER=inert"]);
  assert.equal(encoded, Startup.encodeEnvironment({ EMPTY: "", A: values.A, Z: values.Z }));
  for (const key of ["", "9KEY", "A=B", "A\0B", "A-B", "é", "A\nB"])
    assert.throws(() => Startup.encodeEnvironment({ [key]: "value" }), /Invalid Android startup environment/);
  for (const value of [null, undefined, 1, "value\0INJECTED=yes"])
    assert.throws(() => Startup.encodeEnvironment({ KEY: value }), /Invalid Android startup environment/);
});

test("native startup vector enforces entry and decoded UTF-8 byte limits including terminators", () => {
  const entries = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["V" + i, ""]));
  assert.equal(decode(Startup.encodeEnvironment(entries)).length, 64);
  assert.throws(() => Startup.encodeEnvironment({ ...entries, LAST: "" }), /exceeds its limit/);
  const value = "é".repeat(8190) + "a";
  assert.equal(Buffer.from(Startup.encodeEnvironment({ A: value }).slice(2), "base64url").length, 16384);
  assert.throws(() => Startup.encodeEnvironment({ A: value + "a" }), /exceeds its limit/);
  assert.throws(() => Startup.encodeEnvironment({ A: value, B: "" }), /exceeds its limit/);
});

test("native startup snapshot admits namespace and selected locale without host controls or credentials", () => {
  const androidEnvironment = Namespace.environment({ dataRoot: "/private/app", partitionsRoot: "/private/runtime/android-root" });
  const extras = { API_TOKEN: "synthetic-secret", AWS_SECRET_ACCESS_KEY: "synthetic-secret", DYLD_INSERT_LIBRARIES: "/host/preload", KL_TRACE: "1", MACLAUNCHER_PROCESS_ID: "host", JAVA_TOOL_OPTIONS: "-javaagent:host", __CF_USER_TEXT_ENCODING: "host", CFFIXED_USER_HOME: "/host" };
  const result = Startup.environment({ androidEnvironment: { ...androidEnvironment, ...extras },
    systemEnvironment: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC", ...extras },
    home: "/private/app/home", temporary: "/private/app/cache/tmp/" });
  const expected = { ...androidEnvironment, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC", HOME: "/private/app/home", TMPDIR: "/private/app/cache/tmp/" };
  assert.deepEqual(Object.keys(result), [variable]);
  assert.deepEqual(decode(result[variable]), Object.keys(expected).sort().map(key => key + "=" + expected[key]));
  androidEnvironment.ANDROID_DATA = "/changed";
  assert.equal(decode(result[variable]).includes("ANDROID_DATA=/changed"), false);
});

test("ordinary app, service and account sandbox preparation automatically snapshots before process and graphics additions", {
  skip: process.platform !== "darwin",
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-native-startup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime"), jdk = path.join(root, "jdk"), java = path.join(jdk, "bin/java");
  const data = path.join(root, "app/data"), files = path.join(data, "files"), cache = path.join(data, "cache");
  for (const directory of [runtime, path.dirname(java), path.join(jdk, "lib"), files, cache]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(java, "unused"); fs.writeFileSync(path.join(jdk, "lib/jspawnhelper"), "unused");
  const configFile = path.join(root, "app/launch.json"); fs.writeFileSync(configFile, "{}");
  const previous = process.env.ANDROID_STARTUP_TEST_SECRET;
  process.env.ANDROID_STARTUP_TEST_SECRET = "synthetic-secret";
  t.after(() => { if (previous === undefined) delete process.env.ANDROID_STARTUP_TEST_SECRET; else process.env.ANDROID_STARTUP_TEST_SECRET = previous; });
  for (const role of [{ packageName: "example.application" }, { packageName: "android", serviceRole: "system" }, { packageName: "android", accountService: 1 }]) {
    const sandbox = await Sandbox.prepareSandbox({ javaPath: java, configFile, dataRoot: data, userDataDir: root,
      config: { runtimeRoot: runtime, filesRoot: files, cacheRoot: cache, ...role },
      graphics: { RESHADE_EFFECT: "fixture-selection", RESHADE_TEST_CONTROL: "host-only" } });
    const expected = { ...Namespace.environment({ dataRoot: data, filesRoot: files, cacheRoot: cache, partitionsRoot: path.join(runtime, "android-root") }),
      HOME: path.join(data, "home"), TMPDIR: path.join(cache, "tmp") + path.sep };
    for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"])
      if (Object.hasOwn(sandbox.environment, key)) expected[key] = sandbox.environment[key];
    assert.deepEqual(decode(sandbox.environment[variable]), Object.keys(expected).sort().map(key => key + "=" + expected[key]));
    assert.equal(sandbox.environment.KL_ANGLE_BACKEND, "metal");
    assert.equal(sandbox.graphics.RESHADE_TEST_CONTROL, "host-only");
    assert.equal(sandbox.environment.ANDROID_STARTUP_TEST_SECRET, undefined);
    assert.equal(Object.keys(expected).some(key => /^(KL|MACLAUNCHER|DYLD|RESHADE)/.test(key)), false);
  }
});
