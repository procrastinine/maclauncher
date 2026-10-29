// Runs the native fixtures of a core build configured with -DBUILD_TESTING=ON:
//   node src/modules/shared/reshade/native/test/run.mjs <core build directory> [fixture...]
// Each fixture runs once per mode. Fixtures that need a Metal device report
// "skipped: no Metal device" when the build's hardware query finds none;
// fixtures that need on-screen windows or user-supplied inputs report which.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Mode arguments and environment values may name {library} (the core library), {build}, {fixtures}
// (this directory), {temporary} (an empty directory per mode, with the
// fixture's generated files) and the user-supplied inputs below.
const LIBRARY = "{library}", TEMPORARY = "{temporary}";
const cpu = (...modes) => ({ metal: false, modes: modes.length ? modes : [[]] });
const gpu = (...modes) => ({ metal: true, modes: modes.length ? modes : [[]] });

/** Inputs that public files do not supply. A fixture that needs one is skipped
 * with this reason unless the variable provides it. */
export const requirements = {
  window: { variable: "MACLAUNCHER_NATIVE_FIXTURE_WINDOWS", reason: "creates on-screen windows; set MACLAUNCHER_NATIVE_FIXTURE_WINDOWS=1 in an interactive session" },
  lossless: { variable: "MACLAUNCHER_NATIVE_FIXTURE_LOSSLESS", argument: "{lossless}", reason: "needs a user-supplied Lossless Scaling DLL in MACLAUNCHER_NATIVE_FIXTURE_LOSSLESS" },
  librashader: { variable: "MACLAUNCHER_NATIVE_FIXTURE_LIBRASHADER", argument: "{librashader}", reason: "needs librashader.dylib from the graphics runtime in MACLAUNCHER_NATIVE_FIXTURE_LIBRASHADER" },
};
const LOSSLESS = requirements.lossless.argument, LIBRASHADER = requirements.librashader.argument;
const needs = (fixture, ...names) => ({ ...fixture, needs: names });

// A one-pass Slang preset whose output is the previous source frame.
const historyPreset = {
  "history.slangp": "shaders = 1\nshader0 = history.slang\nfilter_linear0 = false\nscale_type0 = source\nscale0 = 1.0\n",
  "history.slang": "#version 450\nlayout(std140, set = 0, binding = 0) uniform UBO { mat4 MVP; } global;\n#pragma stage vertex\n"
    + "layout(location = 0) in vec4 Position;\nlayout(location = 1) in vec2 TexCoord;\nlayout(location = 0) out vec2 vTexCoord;\n"
    + "void main() { gl_Position = global.MVP * Position; vTexCoord = TexCoord; }\n#pragma stage fragment\n"
    + "layout(location = 0) in vec2 vTexCoord;\nlayout(location = 0) out vec4 FragColor;\n"
    + "layout(set = 0, binding = 2) uniform sampler2D OriginalHistory1;\nvoid main() { FragColor = texture(OriginalHistory1, vTexCoord); }\n",
};
const identityPreset = {
  "identity.slangp": historyPreset["history.slangp"].replace("history.slang", "identity.slang"),
  "identity.slang": historyPreset["history.slang"].replaceAll("OriginalHistory1", "Source"),
};
// Live effect directories: {temporary}/plan lists immutable revisions, each
// with its prepared effect. File values of {fixture} copy a file from here.
const [A, D, C] = ["1", "2", "3"].map(digit => digit.repeat(64));
const live = (...effects) => ({
  env: { RESHADE_LIVE_EFFECTS: TEMPORARY, RESHADE_CONTROL_FILE: TEMPORARY + "/controls.bin", RESHADE_EFFECT_KEY: "a".repeat(64) },
  files: { plan: effects.map(([revision]) => revision + "\n").join(""),
    ...Object.fromEntries(effects.map(([revision, fixture]) => [revision + "/effect.prepared.fx", { fixture }])) },
});
const liveEffects = live([A, "live-grayscale.fx"], [D, "live-sharpen.fx"], [C, "live-chain.fx"]);
const virtualWindowModes = [[], ["--active"], ["--diagnostics"], ["--unchanged-divisor"], ["--unchanged-height"], ["--unchanged-maximum"],
  ["--fullscreen-failure"], ["--resize-constraints"], ["--prepared-fullscreen"], ["--dormant-activation"], ["--already-satisfied"],
  ["--publisher-contract"], ["--live-source"], ["--fullscreen"], ["--live-source", "--fullscreen"]];

/** Fixtures by name: executable in build/test (the name unless given) or a
 * node script here, the arguments of each mode, Metal and other requirements,
 * extra environment and files generated into {temporary}. An optional
 * executable that was not built is skipped with its reason. */
export const fixtures = {
  "hook-originals": cpu(),
  "runtime-status": cpu(),
  "native-config": cpu([TEMPORARY]),
  "effects-plan": cpu(),
  "image-processing-demand": cpu([], ["--generation-models"]),
  "temporal-plan": cpu(),
  "dormant-activation": cpu([LIBRARY], [LIBRARY, "--installed-hooks"], [LIBRARY, "--readability-formats"]),
  "explicit-constructor": cpu([LIBRARY], [LIBRARY, "--ordinary-off"]),
  "diagnostics-checkpoint": cpu(),
  "diagnostic-file": cpu([], ["--disabled"], ["--hooks"]),
  "native-log": cpu(["off"], ["file"], ["limit"], ["invalid"]),
  "generation-budget": cpu(),
  "image-budget": cpu(),
  "source-timing": cpu(),
  "resolution-scale": cpu(...["automatic", "automatic-invalid", "automatic-conflict", "maximum", "exact", "divisor", "publisher-control"].map(mode => [mode])),
  "publisher-pixels": cpu(),
  "uniform-sources": cpu(),
  "virtual-visibility": cpu(),
  "browser-frame-policy": cpu(),
  "color-contract": cpu(),
  "depth-demand": cpu(),
  "window-binding": cpu(),
  "command-deadline": cpu(),
  "overlay-drawables": cpu(),
  "bitmap-surface": cpu(),
  "metal-library-cache": cpu(),
  "quartz-frame": cpu(),
  "source-control": cpu(),
  "presentation-hold": cpu(["--protocol"]),
  "in-place-history": gpu(["--cpu"], []),
  "metal-scene-ingress": gpu(),
  "held-frame-contract": gpu(),
  "effects-fallback": gpu([], ["--candidate-geometry"], ["--origin-contract"], ["--scene-generation"], ["--temporal-fallback"], ["--memory-color-fallback"], ["--fsr-scratch"]),
  "graph-transitions": gpu(["--history"], ["--release"]),
  "contents-geometry": gpu(),
  "effects-fallback generation": needs({ ...gpu(["--generation-geometry", LOSSLESS]), executable: "effects-fallback" }, "lossless"),
  "image-admission": cpu(),
  "image-pool": cpu(),
  "retroarch-history": cpu(),
  "retroarch-history-gpu": needs({ ...gpu(["--gpu", TEMPORARY + "/history.slangp", LIBRASHADER]), files: historyPreset }, "librashader"),
  "virtual-control-stop": cpu(),
  "browser-frame-lifetime": cpu(),
  "browser-frame-callbacks": cpu(),
  "graphics-video": cpu(),
  "provider": cpu([LIBRARY]),
  "presentation-lifecycle": cpu(),
  "presentation-failure": cpu(),
  "presentation-generation-failure": cpu(),
  "presentation-reentrant": gpu(["--tickets"], []),
  "presentation-replay": gpu(),
  "opengl-retirement": { ...cpu(), env: { RESHADE_EXPLICIT_HOST: "1" } },
  "presentation-hold window": needs({ ...gpu(), executable: "presentation-hold" }, "window"),
  "virtual-window": needs(gpu(...virtualWindowModes), "window"),
  "adaptive-presentation-test": needs(gpu(), "window"),
  "adaptive-presentation-test generation": needs({ ...gpu(["generation", LOSSLESS]), executable: "adaptive-presentation-test" }, "window", "lossless"),
  "adaptive-presentation-test live": needs({ ...gpu(["live", LOSSLESS]), executable: "adaptive-presentation-test",
    env: { RESHADE_CONTROL_FILE: TEMPORARY + "/controls.bin", RESHADE_LIVE_EFFECTS: TEMPORARY, RESHADE_LOSSLESS_MODEL: LOSSLESS } }, "window", "lossless"),
  "presentation-epoch": needs(gpu([LOSSLESS], ["--visibility", LOSSLESS]), "window", "lossless"),
  "presentation-observed-fg": needs(gpu([LOSSLESS]), "window", "lossless"),
  "neural-presentation": needs(gpu(["{build}/test/libneural-provider.dylib"], ["--color-contract"], ["--visibility", "{build}/test/libneural-provider.dylib"]), "window"),
  "source-texture": cpu([TEMPORARY + "/textures"]),
  "neural-state": cpu(),
  "neural-node": gpu(["{build}/test/libneural-provider.dylib"], ["--offline", "{build}/test/libneural-provider.dylib"]),
  "spatial-test": gpu(),
  "fsr1-scratch": gpu(),
  "metal-library-reuse": gpu(),
  "metal-float": gpu(),
  "metal-float queue": { ...gpu(["--pure-scaler-queue"]), executable: "metal-float", env: { RESHADE_EXPLICIT_HOST: "1" } },
  "metal-float retroarch": needs({ ...gpu(["--retroarch-history", TEMPORARY + "/history.slangp", LIBRASHADER], ["--retroarch-queue", TEMPORARY + "/identity.slangp", LIBRASHADER]),
    executable: "metal-float", env: { RESHADE_EXPLICIT_HOST: "1" }, files: { ...historyPreset, ...identityPreset } }, "librashader"),
  "effect-placement": { ...gpu([TEMPORARY + "/plan", TEMPORARY + "/controls.bin"]), ...live([A, "effect-placement.fx"], [D, "effect-placement-depth.fx"]) },
  "live-effects": { ...gpu(["metal", TEMPORARY + "/plan", TEMPORARY + "/controls.bin"]), ...liveEffects },
  "live-effects gl": needs({ ...gpu(["gl", TEMPORARY + "/plan", TEMPORARY + "/controls.bin"]), ...liveEffects, executable: "live-effects" }, "window"),
  "opengl-depth-effect": needs({ ...gpu([TEMPORARY]), files: { "depth.fx": { fixture: "effect-placement-depth.fx" }, "gray.fx": { fixture: "live-grayscale.fx" } } }, "window"),
  "live-parameters": cpu(["--control-tokens"]),
  "live-parameters effect": { ...gpu([TEMPORARY + "/strength.fx", TEMPORARY + "/controls.bin"]), executable: "live-parameters", files: { "strength.fx": { fixture: "live-strength.fx" } } },
  "live-parameters lazy": { ...gpu([TEMPORARY + "/lazy.fx", TEMPORARY + "/controls.bin", "--lazy"]), executable: "live-parameters", files: { "lazy.fx": { fixture: "live-lazy.fx" } } },
  "live-control-tokens": cpu(),
  "libplacebo-node": { ...gpu(), optional: "built only when MACLAUNCHER_FIXTURE_LIBPLACEBO names libmacfx-libplacebo.dylib" },
  "compiler": { ...cpu(["{build}/fx-compile"]), script: "compiler.mjs" },
};

// Launch, diagnostic and effect variables of the calling process must not
// select behavior inside a fixture.
const environment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(DYLD_|RESHADE_|KLEPTON_|KL_|MACLAUNCHER_TEST_)/.test(name)));

/** Name of the default Metal device, or null when the build's hardware query finds none. */
export function metalDevice(build) {
  const query = path.join(build, "maclauncher-graphics-hardware");
  const result = spawnSync(query, [], { env: environment(), encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error("The hardware query failed: " + query);
  return JSON.parse(result.stdout).device?.name ?? null;
}

/** Run the selected fixtures and return one record per fixture mode. */
export function runFixtures(build, { only = [], timeout = 120000, log = () => {} } = {}) {
  build = path.resolve(build);
  for (const name of only) if (!fixtures[name]) throw new Error("Unknown native fixture: " + name);
  const device = metalDevice(build), results = [];
  const values = { "{library}": path.join(build, "libreshade-macos.dylib"), "{build}": build, "{fixtures}": path.dirname(fileURLToPath(import.meta.url)) };
  for (const { variable, argument } of Object.values(requirements)) if (argument && process.env[variable]) values[argument] = path.resolve(process.env[variable]);
  for (const [name, { metal, modes, executable: file = name, script, optional, needs = [], env = {}, files = {} }] of Object.entries(fixtures)) {
    if (only.length && !only.includes(name)) continue;
    const executable = script ? path.join(values["{fixtures}"], script) : path.join(build, "test", file);
    const missing = needs.filter(key => !process.env[requirements[key].variable]);
    for (const mode of modes) {
      const label = [name, ...mode.filter(value => !value.includes("{") && !name.split(" ").includes(value))].join(" ");
      let record;
      if (!fs.existsSync(executable)) record = optional ? { status: "skip", reason: optional } : { status: "fail", reason: "not built (configure with -DBUILD_TESTING=ON)" };
      else if (missing.length) record = { status: "skip", reason: missing.map(key => requirements[key].reason).join("; ") };
      else if (metal && !device) record = { status: "skip", reason: "no Metal device" };
      else {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-native-fixture-"));
        try {
          for (const [relative, value] of Object.entries(files)) {
            const target = path.join(temporary, relative);fs.mkdirSync(path.dirname(target), { recursive: true });
            if (typeof value === "string") fs.writeFileSync(target, value);else fs.copyFileSync(path.join(values["{fixtures}"], value.fixture), target);
          }
          const resolve = value => value.replace(/\{[a-z]+\}/g, token => token === TEMPORARY ? temporary : values[token] ?? token);
          const variables = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, resolve(value)]));
          const [command, args] = script ? [process.execPath, [executable, ...mode.map(resolve)]] : [executable, mode.map(resolve)];
          const result = spawnSync(command, args, { cwd: build, env: { ...environment(), ...variables }, encoding: "utf8", timeout, maxBuffer: 16 << 20 });
          const output = (result.stdout + result.stderr).trim().split("\n").slice(-4).join("\n");
          // Exit 77 reports a host the fixture does not apply to; exit 134 is a
          // failed fixture assertion (fixture-assert.cpp). A signal is a crash.
          record = result.status === 0 ? { status: "pass", output } : result.status === 77 ? { status: "skip", reason: "unsupported on this host", output }
            : { status: "fail", reason: result.error ? result.error.message : result.signal ? "crashed with signal " + result.signal
              : result.status === 134 ? "assertion failed (exit 134)" : "exit " + result.status, output };
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      }
      results.push({ fixture: name, mode: label, ...record });
      log(record.status === "pass" ? "PASS " + label : record.status === "skip" ? "SKIP " + label + ": skipped: " + record.reason
        : "FAIL " + label + ": " + record.reason + (record.output ? "\n  " + record.output.replaceAll("\n", "\n  ") : ""));
    }
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [build, ...only] = process.argv.slice(2);
  if (!build || !fs.existsSync(path.join(build, "CMakeCache.txt")))
    throw new Error("Usage: node run.mjs <core build directory configured with -DBUILD_TESTING=ON> [fixture...]");
  const results = runFixtures(build, { only, log: line => console.log(line) });
  const count = status => results.filter(result => result.status === status).length;
  console.log(`${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`);
  process.exitCode = count("fail") ? 1 : 0;
}
