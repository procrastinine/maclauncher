import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Offline developer tool. Ordinary native builds consume the checked-in array.
const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
let compiler = "glslang", check = false;
for (let index = 0; index < args.length; ++index) {
  if (args[index] === "--check") check = true;
  else if (args[index] === "--glslang" && args[index + 1]) compiler = args[++index];
  else throw new Error("Usage: node compat/fsr/generate.mjs [--glslang executable] [--check]");
}
const upstream = path.join(root, "third_party/fsr"), destination = import.meta.dirname;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-shaders-"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
try {
  const compilerVersion = execFileSync(compiler, ["--version"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }).split("\n")[0];
  const pin = "a21ffb8f6c13233ba336352bdff293894c706575";
  let header = `// Generated from the owned FSR GLSL wrapper and AMD FSR1 ${pin}.\n/*\n${fs.readFileSync(path.join(upstream, "license.txt"), "utf8")}\n*/\n#pragma once\n#include <array>\n#include <cstdint>\nnamespace macfx::fsr1::embedded {\n`;
  const receipt = { upstreamCommit: pin, compilerVersion, target: "vulkan1.1", sourceSha256: hash(fs.readFileSync(path.join(destination, "fsr.comp"))), shaders: {} };
  for (const [name, easu, format] of [["easu", 1, "rgba16f"], ["rcas8", 0, "rgba8"], ["rcas16", 0, "rgba16f"]]) {
    const output = path.join(temporary, name + ".spv");
    execFileSync(compiler, ["-V", "--target-env", "vulkan1.1", "-I" + path.join(upstream, "ffx-fsr"), "-DEASU=" + easu, "-DOUTPUT_FORMAT=" + format, path.join(destination, "fsr.comp"), "-o", output], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const bytes = fs.readFileSync(output);
    if (bytes.length % 4 || bytes.readUInt32LE(0) !== 0x07230203) throw new Error("Invalid generated SPIR-V");
    receipt.shaders[name] = { bytes: bytes.length, sha256: hash(bytes) };
    header += `inline constexpr std::array<uint32_t,${bytes.length / 4}> ${name}={\n`;
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const words = [];
      for (let word = offset; word < Math.min(offset + 32, bytes.length); word += 4) words.push("0x" + bytes.readUInt32LE(word).toString(16).padStart(8, "0") + "u");
      header += " " + words.join(",") + ",\n";
    }
    header += "};\n";
  }
  header += "}\n";
  receipt.headerSha256 = hash(header);
  for (const [name, text] of [["fsr1-shaders.hpp", header], ["fsr1-shaders.json", JSON.stringify(receipt, null, 2) + "\n"]]) {
    const file = path.join(destination, name);
    if (check) { if (fs.readFileSync(file, "utf8") !== text) throw new Error("Generated shader differs: " + name); }
    else fs.writeFileSync(file, text);
  }
  console.log(check ? "FSR1 embedded shaders match their sources." : "FSR1 embedded shaders regenerated.");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
