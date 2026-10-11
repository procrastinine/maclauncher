const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const Python = require("../src/modules/shared/runtime/portable-python-v2");
const Base = require("../src/modules/shared/runtime/portable-python");
const hash = file => require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function temporary(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-python-linker-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("Python v2 preserves the exact source/module/configure profile and adds only the linker object-path option", () => {
  assert.equal(Base.PIN.version, "python-embedded-macos13-v1");
  assert.equal(Python.PIN.version, "python-embedded-macos13-v2");
  assert.deepEqual(Python.PIN.source, Base.PIN.source);
  assert.deepEqual(Python.PIN.options, Base.PIN.options);
  assert.deepEqual(Python.PIN.disabledModules, Base.PIN.disabledModules);
  const input = { sdk: "/SDK", sourceRoot: "/tmp/source", workRoot: "/tmp/build" };
  const old = Base.compilerEnvironment(input), current = Python.compilerEnvironment(input);
  assert.deepEqual({ ...current, LDFLAGS: old.LDFLAGS }, old);
  assert.equal(current.LDFLAGS, old.LDFLAGS + " -Wl,-oso_prefix,/tmp/build/");
  assert.throws(() => Python.linkerOptions("/tmp/with,comma"), /commas/);
  assert.throws(() => Python.linkerOptions("/tmp/$(command)"), /metacharacters/);
  assert.throws(() => Python.linkerOptions("relative"), /absolute/);
});
test("real Apple linker makes object records relative without changing native code or exports", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), source = path.join(root, "example.c"), object = path.join(root, "example.o");
  fs.writeFileSync(source, "const char *source_name(void) { return __FILE__; }\nint answer(void) { return 42; }\n");
  const options = { encoding: "utf8", stdio: "pipe", timeout: 30000 };
  const cpu = process.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync("/usr/bin/clang", ["-g", "-arch", cpu, "-mmacosx-version-min=13.0", `-ffile-prefix-map=${root}=example-source`, `-fdebug-prefix-map=${root}=example-source`, "-c", source, "-o", object], options);
  const objectSha = hash(object), old = path.join(root, "old.dylib"), current = path.join(root, "relative.dylib");
  for (const [output, extra] of [[old, []], [current, Python.linkerOptions(root)]]) execFileSync("/usr/bin/clang", ["-dynamiclib", "-arch", cpu, "-mmacosx-version-min=13.0", "-Wl,-install_name,@rpath/example.dylib", ...extra, object, "-o", output], options);
  assert.equal(fs.readFileSync(old).includes(Buffer.from(root + "/example.o")), true);
  assert.equal(fs.readFileSync(current).includes(Buffer.from(root)), false);
  assert.equal(hash(object), objectSha);
  const symbols = file => execFileSync("/usr/bin/nm", ["-gU", file], options).split("\n").filter(Boolean).map(line => line.trim().split(/\s+/).at(-1)).sort();
  assert.deepEqual(symbols(current), symbols(old));
  const code = file => execFileSync("/usr/bin/otool", ["-s", "__TEXT", "__text", file], options).split("\n").slice(2).join("\n");
  assert.equal(code(current), code(old));
});
test("cancelled Python v2 creates no output and retains the old helper identity", async t => {
  const root = temporary(t), output = path.join(root, "output"), before = Base.recipeIdentity();
  await assert.rejects(Python.buildPython({ workRoot: output, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(fs.existsSync(output), false);
  assert.equal(Base.recipeIdentity(), before);
});
