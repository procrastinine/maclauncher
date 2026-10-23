const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-effects-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, "resources"), declarationPath = path.join(root, "declaration.json"), effectsDirectory = path.join(root, "effects");
  const version = "0.1.0-aaaaaaaa-12345678", directoryRelative = `reshade/${version}/universal`, payload = path.join(resourceRoot, directoryRelative);
  const executable = Buffer.alloc(128); executable.writeUInt32BE(0xcafebabe); executable.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x100000c, 0x1000007].entries()) {
    const table = 8 + index * 20, start = 64 + index * 32;
    executable.writeUInt32BE(cpu, table); executable.writeUInt32BE(start, table + 8); executable.writeUInt32BE(32, table + 12);
    executable.writeUInt32LE(0xfeedfacf, start); executable.writeUInt32LE(cpu, start + 4); executable.writeUInt32LE(2, start + 12);
  }
  const files = [];
  for (const [relative, content] of [["libreshade-macos.dylib", executable], ["libvkd3d-shader.dylib", executable], ["fx-compile", executable], ["source.tar.gz", "exact source archive"],
    ["licenses/notice.txt", "original notice"], ["include/ReShade.fxh", "original include"], ["effects/retired.fx", "old effect"]]) {
    const native = ["libreshade-macos.dylib", "libvkd3d-shader.dylib", "fx-compile"].includes(relative);
    const mode = native ? 0o755 : 0o644, bytes = Buffer.from(content), target = path.join(payload, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { mode });
    files.push({ path: relative, sha256: hash(bytes), size: bytes.length, mode, ...(native ? { architectures: ["arm64", "x86_64"] } : {}) });
  }
  const manifest = { schema: 1, version, minimumMacOS: "13.0", architectures: ["arm64", "x86_64"], sourceHash: "a".repeat(64), sourcePins: ["b".repeat(40) + " third_party/compiler"], files };
  const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(payload, "runtime.json"), bytes);
  const declaration = { id: "reshade", version, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS: "13.0",
    sourceRelative: "source.tar.gz", sourceSha256: files.find(file => file.path === "source.tar.gz").sha256,
    directoryRelative, manifestRelative: "runtime.json", manifestSha256: hash(bytes),
    files: [...files, { path: "runtime.json", sha256: hash(bytes), size: bytes.length, mode: 0o644 }],
    notices: [{ name: "Original notice", license: "BSD-3-Clause", path: "licenses/notice.txt" }] };
  fs.writeFileSync(declarationPath, JSON.stringify([declaration])); fs.mkdirSync(effectsDirectory);
  fs.writeFileSync(path.join(effectsDirectory, "grayscale.fx"), "new grayscale effect");
  const signatures = [];
  const dependencies = { loadCommands: () => ({ minimumMacOS: "13.0" }), verifySignature: file => signatures.push(file) };
  return { root, resourceRoot, declarationPath, effectsDirectory, dependencies, payload, declaration, manifest, signatures };
}

test("effects-only staging preserves sealed native bytes and provenance in an immutable content version", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const before = new Map(f.declaration.files.map(file => [file.path, fs.readFileSync(path.join(f.payload, file.path))]));
  const result = stageReShadeEffects(f), next = JSON.parse(fs.readFileSync(f.declarationPath))[0];
  assert.notEqual(result.version, f.declaration.version);
  assert.equal(result.nativePayloadPreserved, true);
  assert.equal(next.sourceSha256, f.declaration.sourceSha256);
  assert.deepEqual(next.notices, f.declaration.notices);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.destination, "runtime.json")));
  assert.equal(manifest.sourceHash, f.manifest.sourceHash); assert.deepEqual(manifest.sourcePins, f.manifest.sourcePins);
  for (const [relative, bytes] of before) {
    assert.deepEqual(fs.readFileSync(path.join(f.payload, relative)), bytes, "original payload stays unchanged");
    if (relative.startsWith("effects/") || relative === "runtime.json") continue;
    assert.deepEqual(fs.readFileSync(path.join(result.destination, relative)), bytes);
    assert.deepEqual(next.files.find(file => file.path === relative), f.declaration.files.find(file => file.path === relative));
  }
  assert.equal(fs.existsSync(path.join(result.destination, "effects/retired.fx")), false);
  assert.equal(fs.readFileSync(path.join(result.destination, "effects/grayscale.fx"), "utf8"), "new grayscale effect");
  assert.equal(stageReShadeEffects(f).version, result.version, "unchanged update reuses its content identity");
  fs.appendFileSync(path.join(f.effectsDirectory, "grayscale.fx"), " changed");
  assert.notEqual(stageReShadeEffects(f).version, result.version);
  if (process.platform === "darwin") assert.ok(f.signatures.length >= 12, "existing and new native signatures are verified without signing");
});

test("effects-only staging rejects a modified sealed payload before changing the active declaration", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const declaration = fs.readFileSync(f.declarationPath);
  fs.appendFileSync(path.join(f.payload, "source.tar.gz"), " altered");
  assert.throws(() => stageReShadeEffects(f), /checksum|bounded|size|limit/i);
  assert.deepEqual(fs.readFileSync(f.declarationPath), declaration);
  assert.deepEqual(fs.readdirSync(path.join(f.resourceRoot, "reshade")), [f.declaration.version]);
});

test("capability-only staging changes content identity and preserves accepted native and source bytes", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const first = stageReShadeEffects(f);
  const features = { graphics: { presentation: { hosts: { window: { spatial: true } } } } };
  const next = stageReShadeEffects({ ...f, features });
  assert.notEqual(next.version, first.version);
  for (const file of ["libreshade-macos.dylib", "fx-compile", "libvkd3d-shader.dylib", "source.tar.gz"])
    assert.deepEqual(fs.readFileSync(path.join(first.destination, file)), fs.readFileSync(path.join(next.destination, file)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(next.destination, "runtime.json"))).features, features);
  assert.equal(stageReShadeEffects({ ...f, features }).version, next.version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.destination, "runtime.json"))).features, undefined);
});

test("effects-only staging rejects effect symlinks and preserves the active payload", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const declaration = fs.readFileSync(f.declarationPath);
  fs.symlinkSync(path.join(f.payload, "source.tar.gz"), path.join(f.effectsDirectory, "outside.fx"));
  assert.throws(() => stageReShadeEffects(f), /regular|symbolic|symlink/i);
  assert.deepEqual(fs.readFileSync(f.declarationPath), declaration);
});

test("third-party effect identities and embedded notices update without changing native provenance", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const source = { name: "Example shader", license: "MIT", path: "effects/grayscale.fx",
    sourceUrl: "https://example.com/shader.fx", revision: "c".repeat(40), sourceSha256: "d".repeat(64),
    sha256: hash(fs.readFileSync(path.join(f.effectsDirectory, "grayscale.fx"))), adaptation: "Portable sampling." };
  const result = stageReShadeEffects({ ...f, effectSources: [source] });
  const declaration = JSON.parse(fs.readFileSync(f.declarationPath))[0];
  assert.deepEqual(declaration.notices, [...f.declaration.notices, { name: source.name, license: source.license, path: source.path, sourceUrl: source.sourceUrl }]);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.destination, "runtime.json")));
  assert.deepEqual(manifest.effectSources, [source]);
  assert.deepEqual(manifest.sourcePins, f.manifest.sourcePins);
  assert.equal(declaration.sourceSha256, f.declaration.sourceSha256);
  assert.equal(stageReShadeEffects({ ...f, effectSources: [source] }).version, result.version);
  assert.equal(stageReShadeEffects(f).version, result.version, "omitting metadata preserves the current identities");
  const changed = stageReShadeEffects({ ...f, effectSources: [{ ...source, adaptation: "Updated source description." }] });
  assert.notEqual(changed.version, result.version, "source metadata belongs to content identity");
  const removed = stageReShadeEffects({ ...f, effectSources: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.declarationPath))[0].notices, f.declaration.notices);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(removed.destination, "runtime.json"))).effectSources, []);
});

test("invalid third-party effect identities leave the active declaration untouched", async t => {
  const { stageReShadeEffects } = await import("../scripts/stage-reshade-effects.mjs"), f = fixture(t);
  const original = fs.readFileSync(f.declarationPath);
  const source = { name: "Example", license: "MIT", path: "effects/grayscale.fx", sourceUrl: "https://example.com/shader.fx",
    revision: "c".repeat(40), sourceSha256: "d".repeat(64), sha256: hash(fs.readFileSync(path.join(f.effectsDirectory, "grayscale.fx"))), adaptation: "Portable sampling." };
  for (const sources of [[{ ...source, sha256: "0".repeat(64) }], [{ ...source, path: "effects/../grayscale.fx" }],
    [{ ...source, sourceUrl: "file:///private/shader.fx" }], [{ ...source, revision: "main" }], [source, source], [{ ...source, receipt: "/private/test.json" }]]) {
    assert.throws(() => stageReShadeEffects({ ...f, effectSources: sources }), /effect source/);
    assert.deepEqual(fs.readFileSync(f.declarationPath), original);
    assert.deepEqual(fs.readdirSync(path.join(f.resourceRoot, "reshade")), [f.declaration.version]);
  }
});

test("corresponding source copies pinned code, excludes private inputs and rejects modified vendor files", async t => {
  const { copyPinnedReShadeSources } = await import("../scripts/stage-reshade-source.mjs");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "source/third_party/compiler"), output = path.join(root, "output");
  fs.mkdirSync(vendor, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", vendor, ...args], { stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(vendor, "source.cpp"), "pinned compiler source");
  fs.writeFileSync(path.join(vendor, "LICENSE"), "upstream terms");
  git("add", "source.cpp", "LICENSE");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source");
  fs.writeFileSync(path.join(vendor, "Lossless.dll"), "private input");
  copyPinnedReShadeSources(path.join(root, "source"), output, ["third_party/compiler"]);
  assert.equal(fs.readFileSync(path.join(output, "third_party/compiler/source.cpp"), "utf8"), "pinned compiler source");
  assert.equal(fs.existsSync(path.join(output, "third_party/compiler/Lossless.dll")), false);
  fs.appendFileSync(path.join(vendor, "source.cpp"), " changed");
  assert.throws(() => copyPinnedReShadeSources(path.join(root, "source"), output, ["third_party/compiler"]));
  assert.throws(() => copyPinnedReShadeSources(path.join(root, "source"), output, ["third_party/../outside"]), /Invalid/);
});

test("MAKO corresponding source includes the adaptive scheduler dependency closure", async t => {
  const { copyPinnedReShadeSources } = await import("../scripts/stage-reshade-source.mjs");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-adaptive-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "source/third_party/mako"), output = path.join(root, "output");
  const render = "engine/mako-render/src/";
  const files = {
    "LICENSE.md": "GPL-3.0-or-later", "README.md": "MAKO",
    "engine/mako-backend/model.cpp": "model", "engine/mako-common/configuration.hpp": "config",
    [`${render}adaptive_scheduler.cpp`]: '#include "adaptive_scheduler.hpp"\n#include "adaptive_policy_limits.hpp"\n',
    [`${render}adaptive_scheduler.hpp`]: '#include "generated_frame_delivery.hpp"\n#include "generated_frame_plan.hpp"\n',
    [`${render}adaptive_policy_limits.hpp`]: "limits", [`${render}generated_frame_delivery.hpp`]: "delivery",
    [`${render}generated_frame_plan.hpp`]: "plan", [`${render}shaders/spatial_scaling.comp`]: "shader",
    [`${render}shaders/spatial_scaling_spirv.hpp`]: "code", [`${render}shaders/spatial_scaling_spirv.hashes`]: "hash",
    "website/unused.dat": "unconsumed website", "plugin/unused.dat": "unconsumed plugin"
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(vendor, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const git = (...args) => execFileSync("git", ["-C", vendor, ...args], { stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source");
  copyPinnedReShadeSources(path.join(root, "source"), output, ["third_party/mako"]);
  const copied = path.join(output, "third_party/mako");
  for (const relative of Object.keys(files).filter(name => name.startsWith(render))) {
    const content = fs.readFileSync(path.join(copied, relative), "utf8");
    assert.equal(content, files[relative]);
    for (const match of content.matchAll(/#include "([^"]+)"/g)) assert.equal(fs.existsSync(path.join(copied, path.dirname(relative), match[1])), true);
  }
  assert.equal(fs.existsSync(path.join(copied, "website")), false);
  assert.equal(fs.existsSync(path.join(copied, "plugin")), false);
});

test("FSR source closure contains consumed headers and notices without sample assets", async t => {
  const { copyPinnedReShadeSources } = await import("../scripts/stage-reshade-source.mjs");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-fsr-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), vendor = path.join(source, "third_party/fsr"), output = path.join(root, "output");
  const files = { "ffx-fsr/ffx_a.h": "types", "ffx-fsr/ffx_fsr1.h": '#include "ffx_a.h"',
    "license.txt": "MIT notice", "readme.md": "FSR1", "sample/assets/unused.bin": "unconsumed sample" };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(vendor, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const git = (...args) => execFileSync("git", ["-C", vendor, ...args], { stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source");
  copyPinnedReShadeSources(source, output, ["third_party/fsr"]);
  const copied = path.join(output, "third_party/fsr");
  for (const relative of ["ffx-fsr/ffx_a.h", "ffx-fsr/ffx_fsr1.h", "license.txt", "readme.md"])
    assert.equal(fs.readFileSync(path.join(copied, relative), "utf8"), files[relative]);
  assert.equal(fs.existsSync(path.join(copied, "sample")), false);
});
