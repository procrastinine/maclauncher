const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Siglus = require("../src/modules/siglus/runtime/profile");
const SiglusCatalog = require("../src/modules/siglus/runtime/catalog");
const KiriKiri = require("../src/modules/kirikiri/catalog");
const Nscripter = require("../src/modules/nscripter/main");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-binary-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const symbols = ["game_run_entry", "game_probe_json", "game_string_free"];
function siglusInput(t, bytes, architecture = "arm64") {
  const root = directory(t), app = architecture === "arm64" ? "Siglus-arm64.app" : "Siglus-x86_64.app";
  const original = path.join(root, app, "Contents/Frameworks/libsiglus.dylib");
  fs.mkdirSync(path.dirname(original), { recursive: true }); fs.writeFileSync(original, bytes);
  return { root, original, pin: SiglusCatalog.reviewedEntry(architecture) };
}
function signatureOnly(calls) { return async (command, args) => {
  assert.equal(command, "/usr/bin/codesign", "binary installs use no compiler or developer inspection tool");
  calls.push(args); return { stdout: "" };
}; }

test("Siglus rejects a missing API, wrong CPU, non-Mac image or outside dependency before publication", async t => {
  for (const spec of [
    { symbols: symbols.slice(0, 2), expected: /direct host API/ },
    { cpu: X64, symbols, expected: /selected native library/ },
    { platform: 2, symbols, expected: /macOS deployment/ },
    { dependencies: ["/opt/homebrew/lib/libSDL.dylib"], symbols, expected: /unbundled/ },
    { runPaths: ["/opt/homebrew/lib"], symbols, expected: /search path/ },
  ]) {
    const bytes = image({ installName: "@rpath/libsiglus.dylib", ...spec });
    const input = siglusInput(t, bytes), calls = [];
    await assert.rejects(Siglus.prepareInstall({ unpacked: input.root, pin: input.pin }, { execFile: signatureOnly(calls) }), spec.expected);
    assert.deepEqual(fs.readFileSync(input.original), bytes); assert.equal(fs.existsSync(path.join(input.root, "siglus-profile.json")), false);
    assert.equal(fs.existsSync(path.join(input.root, "bin")), false);
  }
});
test("Siglus verifies exports from the selected CPU rather than another universal slice", async t => {
  const bytes = universal([{ cpu: X64, bytes: image({ cpu: X64, installName: "@rpath/libsiglus.dylib", symbols: symbols.slice(0, 2) }) },
    { cpu: ARM64, bytes: image({ installName: "@rpath/libsiglus.dylib", symbols }) }]);
  const good = siglusInput(t, bytes), calls = [];
  await Siglus.prepareInstall({ unpacked: good.root, pin: good.pin }, { execFile: signatureOnly(calls) });
  assert.equal(calls.length, 2); assert.deepEqual(fs.readFileSync(path.join(good.root, "lib/libsiglus.dylib")), bytes);
  const bad = siglusInput(t, bytes, "x64");
  await assert.rejects(Siglus.prepareInstall({ unpacked: bad.root, pin: bad.pin }, { execFile: signatureOnly([]) }), /direct host API/);
});
test("KiriKiri verifies every universal slice before signing the managed executable", async t => {
  const root = directory(t), executable = path.join(root, "krkrsdl2"), calls = [];
  const pin = { asset: { filename: "krkrsdl2-macos.zip" }, executableRelative: "krkrsdl2", version: "development-fixture" };
  const bytes = universal([{ cpu: X64, bytes: image({ cpu: X64, fileType: 2, installName: null }) },
    { cpu: ARM64, bytes: image({ fileType: 2, installName: null }) }]);
  fs.writeFileSync(executable, bytes);
  await KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) });
  assert.deepEqual(calls, [["--force", "--sign", "-", executable], ["--verify", "--strict", executable]]);
  const bad = universal([{ cpu: X64, bytes: image({ cpu: X64, fileType: 2, installName: null, dependencies: ["@rpath/libMissing.dylib"] }) },
    { cpu: ARM64, bytes: image({ fileType: 2, installName: null }) }]);
  fs.writeFileSync(executable, bad); calls.length = 0;
  await assert.rejects(KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) }), /unbundled/);
  assert.equal(calls.length, 0); assert.deepEqual(fs.readFileSync(executable), bad);
});
test("KiriKiri rejects invalid deployment metadata and truncation before signing", async t => {
  const root = directory(t), executable = path.join(root, "krkrsdl2");
  const pin = { asset: { filename: "krkrsdl2-macos.zip" }, executableRelative: "krkrsdl2", version: "development-fixture" };
  for (const bytes of [image({ fileType: 2, installName: null, platform: 2 }), image({ fileType: 2, installName: null, platform: null }),
    image({ fileType: 2, installName: null }).subarray(0, 40)]) {
    fs.writeFileSync(executable, bytes); const calls = [];
    await assert.rejects(KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) }));
    assert.equal(calls.length, 0);
  }
});
test("NScripter missing-library diagnostics retain paths with spaces and need no external inspection", t => {
  const root = directory(t), executable = path.join(root, "onsyuri");
  const missing = "/outside directory/liblua.5.5.dylib";
  fs.writeFileSync(executable, image({ fileType: 2, installName: null,
    dependencies: ["/usr/lib/libSystem.B.dylib", missing, "@rpath/libRelative.dylib"] }));
  const result = Nscripter.__test.listMissingDylibs(executable, { platform: "darwin", existsFn: () => false });
  assert.deepEqual(result, { missing: [missing], brewHints: ["lua"] });
  fs.writeFileSync(executable, Buffer.from("not a Mach-O"));
  assert.equal(Nscripter.__test.listMissingDylibs(executable, { platform: "darwin" }), null);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => Nscripter.__test.listMissingDylibs(executable, { platform: "darwin", signal: controller.signal }), { code: "ABORT_ERR" });
});
