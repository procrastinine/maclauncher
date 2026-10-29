const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");

test("native render allocation follows presentation extents and preserves Auto and Simple contracts", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-resolution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "render-resolution");
  const native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  // resolution-scale.hpp reads the launch configuration parsed by native-config.mm.
  const compiled = spawnSync("/usr/bin/clang++", ["-std=c++17", "-fobjc-arc", "-I", native,
    path.join(__dirname, "native/render-resolution.cpp"), path.join(native, "native-config.mm"), "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const base = { ...process.env };
  for (const key of ["RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_MULTIPLIER", "RESHADE_SPATIAL_METHOD", "RESHADE_RESOLUTION_MULTIPLIER"]) delete base[key];
  const check = (env, expected) => {
    const result = spawnSync(binary, [], { env: { ...base, ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\s+/).map(Number), expected);
  };
  const unchanged = [0, 1280, 720, 1280, 720, 3840, 2160, 320, 240, 1280, 720];
  check({}, unchanged);
  check({ RESHADE_SPATIAL_METHOD: "off", RESHADE_RESOLUTION_MULTIPLIER: "2" }, unchanged);
  check({ RESHADE_SPATIAL_METHOD: "off", RESHADE_RENDER_MULTIPLIER: "3" }, [1, 640, 360, 427, 240, 1280, 720, 107, 80, 1280, 720]);
  check({ RESHADE_RENDER_MULTIPLIER: "1.6" }, [1, 1200, 675, 800, 450, 2400, 1350, 200, 150, 1280, 720]);
  check({ RESHADE_RENDER_MULTIPLIER: "1.5", RESHADE_SPATIAL_METHOD: "bilinear", RESHADE_RESOLUTION_MULTIPLIER: "2" }, [1, 1280, 720, 854, 480, 2560, 1440, 214, 160, 1280, 720]);
  check({ RESHADE_SPATIAL_METHOD: "bilinear", RESHADE_RESOLUTION_MULTIPLIER: "2" }, [1, 960, 540, 640, 360, 1920, 1080, 160, 120, 1280, 720]);
  check({ RESHADE_SPATIAL_METHOD: "off", RESHADE_RENDER_HEIGHT: "480" }, [1, 854, 480, 854, 480, 854, 480, 320, 240, 1280, 720]);
  check({ RESHADE_RENDER_HEIGHT: "720", RESHADE_RENDER_MULTIPLIER: "invalid" }, [1, 1280, 720, 1280, 720, 1280, 720, 320, 240, 1280, 720]);
  for (const env of [{ RESHADE_RENDER_HEIGHT: "480.5" }, { RESHADE_RENDER_HEIGHT: "16385" }, { RESHADE_RENDER_MULTIPLIER: "0.5" }]) {
    const result = spawnSync(binary, [], { env: { ...base, ...env }, encoding: "utf8" });
    assert.equal(result.status, 1);assert.match(result.stderr, /Game rendering/);
  }
});
