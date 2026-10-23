import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => index % 2 ? items : [...items, [value.replace(/^--/, ""), all[index + 1]]], []));
if (!["source", "out", "compiler", "reference"].every(key => args[key])) throw Error("Use --source Streamline --out directory --compiler clang++ --reference sl.interposer.dll");
const source = path.resolve(args.source), output = path.resolve(args.out), reference = path.resolve(args.reference);
const revision = "b998246a3d499c08765c5681b229c9e6b4513348";
if (execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== revision) throw Error("Streamline headers must match the pinned source revision");
const exports = require("./pe-exports").inspect(reference);
if (!exports) throw Error("A complete named x64 Streamline export table is required");
const core = [...fs.readFileSync(path.join(source, "include/sl_core_api.h"), "utf8").matchAll(/^sl::Result (sl\w+)\(|^SL_API sl::Result (sl\w+)\(/gm)].map(match => match[1] || match[2]);
const known = new Set([...fs.readFileSync(path.join(source, "source/core/sl.interposer/exports.def"), "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z_]\w*$/.test(line) && line !== "EXPORTS"), ...core, "slSetVulkanInfo"]);
if (exports.some(item => !known.has(item.name)) || ["slSetConstants", "slEvaluateFeature", "slShutdown"].some(name => !exports.some(item => item.name === name))) throw Error("The reference exports do not match the pinned Streamline API");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "exports.def"), "LIBRARY sl.interposer\nEXPORTS\n" + exports.map(item => `${item.name} @${item.ordinal}`).join("\n") + "\n");
fs.writeFileSync(path.join(output, "exports.hpp"), `#pragma once\nconstexpr unsigned maclauncherExportCount = ${exports.length};\nstatic const char *maclauncherExportNames[] = {${exports.map(item => JSON.stringify(item.name)).join(",")}};\nextern "C" void *maclauncherTargets[maclauncherExportCount];\n`);
const hooks = new Set(["slSetConstants", "slEvaluateFeature", "slShutdown"]);
const thunks = exports.flatMap(({ name }, i) => hooks.has(name) ? [] : [`
.text
.p2align 4
.globl ${name}
.def ${name}; .scl 2; .type 32; .endef
.seh_proc ${name}
${name}:
    movq maclauncherTargets+${i * 8}(%rip), %rax
    testq %rax, %rax
    jne .Lready${i}
    subq $136, %rsp
    .seh_stackalloc 136
    .seh_endprologue
    movq %rcx, 32(%rsp)
    movq %rdx, 40(%rsp)
    movq %r8, 48(%rsp)
    movq %r9, 56(%rsp)
    movups %xmm0, 64(%rsp)
    movups %xmm1, 80(%rsp)
    movups %xmm2, 96(%rsp)
    movups %xmm3, 112(%rsp)
    movl $${i}, %ecx
    call maclauncherResolveExport
    movq 32(%rsp), %rcx
    movq 40(%rsp), %rdx
    movq 48(%rsp), %r8
    movq 56(%rsp), %r9
    movups 64(%rsp), %xmm0
    movups 80(%rsp), %xmm1
    movups 96(%rsp), %xmm2
    movups 112(%rsp), %xmm3
    addq $136, %rsp
.Lready${i}:
    jmp *%rax
.seh_endproc
`]).join("\n");
fs.writeFileSync(path.join(output, "thunks.S"), thunks);
execFileSync(path.resolve(args.compiler), ["-std=c++17", "-O2", "-shared", "-static", "-Wl,--exclude-all-symbols", "-Wl,--no-insert-timestamp", "-I" + path.join(source, "include"), "-I" + output,
  path.join(here, "proxy.cpp"), path.join(output, "thunks.S"), path.join(output, "exports.def"), "-o", path.join(output, "sl.interposer.dll")], { stdio: "inherit" });
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const metadata = { schema: 1, version: "1", source: { url: "https://github.com/NVIDIA-RTX/Streamline", revision, version: "2.9.0", license: "MIT" },
  library: "sl.interposer.dll", sha256: hash(path.join(output, "sl.interposer.dll")), referenceSha256: hash(reference), exports,
  compiler: execFileSync(path.resolve(args.compiler), ["--version"], { encoding: "utf8" }).split("\n")[0],
  sources: Object.fromEntries(["build.mjs", "proxy.cpp", "camera.hpp", "pe-exports.js", "../../../shared/reshade/temporal/camera.h", "../../../shared/reshade/temporal/frame.h"].map(file => [file, hash(path.resolve(here, file))])) };
fs.copyFileSync(path.join(source, "license.txt"), path.join(output, "Streamline-LICENSE.txt"));
fs.writeFileSync(path.join(output, "provider.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify({ library: path.join(output, metadata.library), exports: exports.length, sha256: metadata.sha256 }));
