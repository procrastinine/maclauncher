import {addLicenses} from './license-files.mjs';
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Content from "./runtime-content.cjs";
import Production from "../src/modules/shared/runtime/production-source.js";

export function productionOwnedFiles(source) {
  return ["CMakeLists.txt", "README.md", ...["src", "compat"].flatMap(directory =>
    fs.readdirSync(path.join(source, directory), { recursive: true }).map(name => path.join(directory, name))
      .filter(name => !Content.excludedReason(name) && fs.statSync(path.join(source, name)).isFile()))].sort();
}

// Only committed upstream source is copied. Runtime inputs and ignored files
// can never enter the corresponding-source archive through this path.
export function copyPinnedReShadeSources(source, destination, consumed, sourceDirectories = {}) {
  const profiles = [];
  for (const relative of consumed) {
    if (!/^third_party\/[a-zA-Z0-9_/-]+$/.test(relative) || relative.split("/").includes("..")) throw new Error("Invalid source dependency path.");
    const directory = sourceDirectories[relative] || path.join(source, relative);
    execFileSync("git", ["-C", directory, "diff", "--exit-code", "--ignore-submodules=all", "HEAD", "--"], { stdio: "pipe" });
    // Include the consumed model, spatial shader and adaptive cadence sources.
    // Separate website and plugin assets are not consumed.
    const scope = relative === "third_party/mako" ? ["engine/mako-backend", "engine/mako-common", "engine/mako-render/src/adaptive_scheduler.cpp", "engine/mako-render/src/adaptive_scheduler.hpp", "engine/mako-render/src/adaptive_policy_limits.hpp", "engine/mako-render/src/generated_frame_delivery.hpp", "engine/mako-render/src/generated_frame_plan.hpp", "engine/mako-render/src/shaders/spatial_scaling.comp", "engine/mako-render/src/shaders/spatial_scaling_spirv.hpp", "engine/mako-render/src/shaders/spatial_scaling_spirv.hashes", "README.md"]
      : relative === "third_party/fsr" ? ["ffx-fsr", "readme.md", "license.txt"]
      : relative === "third_party/reshade" ? ["source", "include", "README.md"]
      : relative === "third_party/reshade/deps/spirv" ? ["include", "README.md"]
      : relative === "third_party/spirv-cross" ? ["*.cpp", "*.hpp", "*.h", "include", "CMakeLists.txt", "cmake", "pkg-config", "README.md"]
      : relative === "third_party/vkd3d" ? ["libs/vkd3d-shader", "libs/vkd3d-common", "include", "README"]
      : relative === "third_party/reshade-shaders" ? ["Shaders", "Textures", "README.md", "REFERENCE.md"] : [];
    // tar may stop reading at the end-of-archive marker, so the archive goes through a file, not a pipe.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-source-"));
    const archive = path.join(staging, "source.tar");
    const target = path.join(destination, relative);
    try {
      execFileSync("git", ["-C", directory, "archive", "--format=tar", `--output=${archive}`, "HEAD", ...scope], { stdio: "pipe" });
      fs.mkdirSync(target, { recursive: true });
      execFileSync("/usr/bin/tar", ["-xf", archive, "-C", target], { stdio: "pipe" });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    addLicenses(destination, relative, directory);
    profiles.push({ path: relative, scope, ...Production.prune(target) });
  }
  return profiles;
}
