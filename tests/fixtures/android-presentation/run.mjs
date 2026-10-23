import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [jdkArg, outputArg, graphicsArg] = process.argv.slice(2);
if (!jdkArg || !outputArg) throw new Error("Usage: node run.mjs <JDK home> <output directory>");
const jdk = path.resolve(jdkArg), output = path.resolve(outputArg);
const root = path.resolve(import.meta.dirname, "../../../src/modules/android/native");
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, ASAN_OPTIONS: "abort_on_error=1", UBSAN_OPTIONS: "halt_on_error=1" };
for (const key of Object.keys(env)) if (/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key)) delete env[key];
const run = (command, args) => execFileSync(command, args, { env, stdio: "inherit", timeout: 30000 });
const sanitize = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
run("clang++", ["-std=c++20", "-dynamiclib", ...sanitize, "-I" + root,
  path.join(import.meta.dirname, "shared-mock.cpp"), "-o", path.join(output, "libshared-mock.dylib")]);
const flags = ["-arch", "arm64", "-mmacosx-version-min=13.0", "-std=c++20", "-O1", "-fobjc-arc",
  "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-Wno-unused-parameter",
  "-Wno-missing-field-initializers", ...sanitize, "-I" + root,
  "-I" + path.join(jdk, "include"), "-I" + path.join(jdk, "include/darwin"),
  "-DPRESENTATION_SOURCE=" + JSON.stringify(path.join(root, "presentation.mm"))];
const frameworks = ["Foundation", "Metal", "QuartzCore", "IOSurface"].flatMap(name => ["-framework", name]);
for (const name of ["lifecycle", "partial"]) run("clang++", [...flags,
  path.join(import.meta.dirname, name + ".mm"), path.join(root,"pixel-copy.mm"), ...frameworks, "-o", path.join(output, name)]);
run(path.join(output, "lifecycle"), [path.join(output, "libshared-mock.dylib")]);
for (const mode of ["missing", "queue", "event", "shader", "pipeline"])
  run(path.join(output, "partial"), [path.join(output, "libshared-mock.dylib"), mode]);
if(graphicsArg){
 run("clang++",[...flags,path.join(import.meta.dirname,"completion.mm"),path.join(root,"pixel-copy.mm"),...frameworks,"-framework","AppKit","-o",path.join(output,"completion")]);
 run(path.join(output,"completion"),[path.resolve(graphicsArg)]);
}
