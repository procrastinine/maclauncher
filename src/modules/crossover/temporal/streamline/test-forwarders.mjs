import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const [payloadArg, compilerArg, outArg] = process.argv.slice(2);
if (!outArg) throw Error("Use PAYLOAD CLANGXX OUTPUT");
const payload = path.resolve(payloadArg), compiler = path.resolve(compilerArg), out = path.resolve(outArg);
const metadata = JSON.parse(fs.readFileSync(path.join(payload, "provider.json"))), hooks = new Set(["slSetConstants", "slEvaluateFeature", "slShutdown", "slSetD3DDevice", "slSetTag", "slSetTagForFrame"]);
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(payload, "sl.interposer.dll"), path.join(out, "sl.interposer.dll"));
fs.writeFileSync(path.join(out, "original.def"), "EXPORTS\n" + metadata.exports.map(item => `${item.name} @${item.ordinal}`).join("\n"));
fs.writeFileSync(path.join(out, "original.S"), metadata.exports.filter(item => item.name !== "CreateDXGIFactory").map(item => `
.text
.globl ${item.name}
.def ${item.name}; .scl 2; .type 32; .endef
${item.name}:
 movl $${1000 + item.ordinal}, %eax
 ret
`).join("\n"));
fs.writeFileSync(path.join(out, "original.cpp"), '#include <cstdint>\nextern "C" double CreateDXGIFactory(double a,uint64_t b,double c,uint64_t d,double e,uint64_t f) { return a + b * 3 + c * 5 + d * 7 + e * 11 + f * 13; }\n');
const checks = metadata.exports.filter(item => !hooks.has(item.name) && item.name !== "CreateDXGIFactory").map(item => `
 { auto fn = (int(*)())GetProcAddress(module, "${item.name}");if (!fn || (void*)fn != (void*)GetProcAddress(module, MAKEINTRESOURCEA(${item.ordinal})) || fn() != ${1000 + item.ordinal} || fn() != ${1000 + item.ordinal}) return ${item.ordinal}; }`).join("\n");
fs.writeFileSync(path.join(out, "forwarders.cpp"), `#include <windows.h>
#include <cstdio>
#include <cstdint>
int main() {
 auto module = LoadLibraryA("sl.interposer.dll");if (!module) return 1001;
 auto mixed = (double(*)(double,uint64_t,double,uint64_t,double,uint64_t))GetProcAddress(module,"CreateDXGIFactory");
 if(!mixed || mixed(.5,2,1.5,4,2.5,6) != 147.5 || mixed(1.5,3,2.5,5,3.5,7) != 187.5) return 1002;
 ${checks}
 std::puts("STREAMLINE_FORWARDERS ${metadata.exports.length - hooks.size} passed (cold/warm, ordinals, integer/floating/stack arguments)");return 0;
}
`);
execFileSync(compiler, ["-O2", "-shared", "-static", path.join(out, "original.cpp"), path.join(out, "original.S"), path.join(out, "original.def"), "-o", path.join(out, "maclauncher_streamline_original.dll")], { stdio: "inherit" });
execFileSync(compiler, ["-O2", "-static", path.join(out, "forwarders.cpp"), "-o", path.join(out, "forwarders.exe")], { stdio: "inherit" });
console.log(path.join(out, "forwarders.exe"));
