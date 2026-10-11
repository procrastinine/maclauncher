const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = "9ccc47a9cab4681a889866f7233a6b016d36a15e";
const OVERLAY_VERSION = "maclauncher-appkit-gl-6";
const SOURCE_HASHES = Object.freeze({
  "Cargo.toml": "dfc0b51bec4aff12670d09bbb1f921f87ba1c04eca3696c6eedf36914389eabc",
  "gm8emulator/Cargo.toml": "5ad88f9dc4fde086cf2c0539bbcd535d8b8294de5cbbfc749305448c085491d7",
  "gm8emulator/build.rs": "00ece0626fc0b81f8ed527c7f785904821d07b3109aa06b419656a7cc44e4cd1",
  "gm8emulator/src/main.rs": "a17cc74a20248c827697a5e984af9a3a74506968090d2b81f357fb9c4097e608",
  "gm8emulator/src/render/opengl.rs": "6bac3d0148f310dd47db52ae72e94e2f022f976dd02f319406a7a473f68ba698",
  "gm8emulator/src/game.rs": "deb43706967194b25c6cfddac2947b66903a5686729241c5138d89f0a79b1706",
  "gm8emulator/src/gml/file.rs": "fedbcc658204875841e345c4e8d60b52298ace00125292c3636b33319f81e3d2",
  "gm8emulator/src/game/includedfile.rs": "809202784031b8eb54d3262c34062ba63107775e0327d58577017475bc22dfea",
  "gm8emulator/src/game/external.rs": "00e382cc4719e6454851bc1c72857abee8e2f90108f9944c17317b67f291d7a9",
  "gm8emulator/src/gml/kernel.rs": "786d88a41ee36aff9de9485da181eba70ce4f25449fd5f651d14c865c5fd3c40"
});
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function applyEmulatorOverlay({ sourceDir, ramenDir, soundioDir }) {
  for (const value of [sourceDir, ramenDir, soundioDir]) if (!path.isAbsolute(value || "")) throw Error("OpenGMK overlay paths must be absolute.");
  const source = fs.realpathSync(sourceDir);
  const external = path.resolve(__dirname, "../../../../external/OpenGMK");
  if (source === external || fs.existsSync(external) && source === fs.realpathSync(external)) throw Error("OpenGMK vendored source is read-only; use an owned source copy.");
  const inputs = {};
  for (const [file, expected] of Object.entries(SOURCE_HASHES)) {
    const location = path.join(source, file), stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || digest(fs.readFileSync(location)) !== expected) {
      throw Error(`OpenGMK ${REVISION} identity check failed for ${file}; no source was patched.`);
    }
    inputs[file] = fs.readFileSync(location, "utf8");
  }
  const ramen = JSON.parse(fs.readFileSync(path.join(ramenDir, "maclauncher-overlay.json"), "utf8"));
  if (ramen.upstreamRevision !== "ef715f65981f6c96f7f889258ff43b63cb472626" || ramen.backend !== "AppKit") throw Error("The pinned AppKit ramen overlay is required.");
  const audioManifest = JSON.parse(fs.readFileSync(path.join(soundioDir, "maclauncher-overlay.json"), "utf8"));
  if (audioManifest.upstreamRevision !== "1ae3cdce620acdaa7996315c05a98a0f12ed8745" || audioManifest.backend !== "CoreAudio") throw Error("The pinned CoreAudio build overlay is required.");
  inputs["Cargo.toml"] += `\n[patch."https://github.com/viriuwu/ramen"]\nramen = { path = ${JSON.stringify(ramenDir)} }\n\n[patch."https://github.com/Adamcake/udon"]\nlibsoundio-sys = { path = ${JSON.stringify(soundioDir)} }\n`;
  inputs["gm8emulator/Cargo.toml"] = inputs["gm8emulator/Cargo.toml"].replace('[dependencies]\n', '[dependencies]\nserde_json = "=1.0.149"\nlewton = "=0.10.2"\n');
  inputs["gm8emulator/Cargo.toml"] += '\n[target.\'cfg(target_os = "macos")\'.build-dependencies]\ncc = "=1.2.60"\n';
  inputs["gm8emulator/build.rs"] = inputs["gm8emulator/build.rs"].replace("    Ok(())\n}", `    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/render/opengl/macos.m")
            .flag("-Wno-deprecated-declarations").compile("maclauncher_opengmk_gl");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=OpenGL");
        println!("cargo:rerun-if-changed=src/render/opengl/macos.m");
    }
    Ok(())\n}`);
  inputs["gm8emulator/src/render/opengl.rs"] = inputs["gm8emulator/src/render/opengl.rs"]
    .replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]')
    .replace("fb_current == self.framebuffer.fbo as _", "fb_current == self.framebuffer.fbo as gl::types::GLint") + '\n#[cfg(target_os = "macos")]\nmod macos;\n#[cfg(target_os = "macos")]\nuse macos as native_gl;\n';
  inputs["gm8emulator/src/game.rs"] = inputs["gm8emulator/src/game.rs"].replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]');
  // Upstream's TAS-only dummy effect bypass is inappropriate for normal Mac
  // gameplay. Every actual DLL definition must reach the native ABI guard.
  inputs["gm8emulator/src/game/external.rs"] = inputs["gm8emulator/src/game/external.rs"]
    .replace('        if dll.eq_ignore_ascii_case("gmeffect_0.1.dll") {', '        if self.dummy_audio && dll.eq_ignore_ascii_case("gmeffect_0.1.dll") {');
  inputs["gm8emulator/src/main.rs"] = inputs["gm8emulator/src/main.rs"]
    .replace("mod action;", "mod maclauncher_inspect;\nmod action;")
    .replace('    opts.optflag("h", "help", "prints this help message");', '    opts.optflag("h", "help", "prints this help message");\n    opts.optflag("", "inspect-json", "parse assets and report extension ABI without running GML");\n    opts.optflag("", "version", "prints the exact MacLauncher source and overlay identity");')
    .replace('    if args.len() < 2 || matches.opt_present("h") {', `    if matches.opt_present("version") {
        println!("OpenGMK 0.2.0 MacLauncher ${REVISION} ${OVERLAY_VERSION}");
        return EXIT_SUCCESS;
    }
    if args.len() < 2 || matches.opt_present("h") {`)
    .replace("    let absolute_path = match file_path.canonicalize() {", `    if matches.opt_present("inspect-json") {
        return match maclauncher_inspect::print_report(&assets) {
            Ok(()) => EXIT_SUCCESS,
            Err(error) => { eprintln!("Asset inspection failed: {}", error); EXIT_FAILURE }
        };
    }

    let absolute_path = match file_path.canonicalize() {`);
  inputs["gm8emulator/src/gml/kernel.rs"] = inputs["gm8emulator/src/gml/kernel.rs"]
    .replace("            #[cfg(unix)]\n            {\n                self.window.xid()\n            }", '            #[cfg(target_os = "linux")]\n            {\n                self.window.xid()\n            }\n            #[cfg(target_os = "macos")]\n            {\n                self.window.nswindow() as usize as f64\n            }');
  inputs["gm8emulator/src/game/external.rs"] = inputs["gm8emulator/src/game/external.rs"]
    .replace("mod wow64;", '#[cfg(not(target_os = "macos"))]\nmod wow64;\n#[cfg(target_os = "macos")]\nmod macos;')
    .replace('#[cfg(not(all(target_os = "windows", target_arch = "x86")))]\nuse wow64 as ipc;', '#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86"))))]\nuse wow64 as ipc;\n#[cfg(target_os = "macos")]\nuse macos as ipc;');
  inputs["gm8emulator/src/game/external.rs"] += '\npub fn native_extension_profiles() -> serde_json::Value {\n    #[cfg(target_os = "macos")] { macos::extension_profiles() }\n    #[cfg(not(target_os = "macos"))] { serde_json::json!([]) }\n}\n';
  require("./apply-paths").applyPathOverlay(inputs);
  require("./apply-highscore").applyHighscoreOverlay(inputs);
  require("./apply-window").applyWindowOverlay(inputs);
  for (const [file, content] of Object.entries(inputs)) fs.writeFileSync(path.join(source, file), content);
  const copies = { "macos.rs": "gm8emulator/src/render/opengl/macos.rs", "macos.m": "gm8emulator/src/render/opengl/macos.m", "external.rs": "gm8emulator/src/game/external/macos.rs", "inspect.rs": "gm8emulator/src/maclauncher_inspect.rs", "paths.rs": "gm8emulator/src/maclauncher_paths.rs", "highscore.rs": "gm8emulator/src/maclauncher_highscore.rs", "window.rs": "gm8emulator/src/maclauncher_window.rs", "supersound.rs": "gm8emulator/src/game/external/macos/supersound.rs" };
  const overlayHashes = {};
  for (const [file, destination] of Object.entries(copies)) {
    const bytes = fs.readFileSync(path.join(__dirname, "renderer", file));
    fs.mkdirSync(path.dirname(path.join(source, destination)), { recursive: true });
    fs.writeFileSync(path.join(source, destination), bytes);
    overlayHashes[file] = digest(bytes);
  }
  const record = { schemaVersion: 1, upstreamRevision: REVISION, overlayVersion: OVERLAY_VERSION,
    sourceHashes: SOURCE_HASHES, overlayHashes, ramen, audio: audioManifest, buildDependency: "cc=1.2.60",
    backend: "AppKit/OpenGL4.1/CoreAudio", windowsExtensionHost: "disabled", nativeExtensionProfiles: ["supersound-string-abi-v1"], externalFilesModified: false };
  fs.writeFileSync(path.join(source, "maclauncher-overlay.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

module.exports = { REVISION, OVERLAY_VERSION, SOURCE_HASHES, applyEmulatorOverlay };
