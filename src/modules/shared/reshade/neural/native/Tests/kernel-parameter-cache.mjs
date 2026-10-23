import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {patchKernelParameters, kernelParametersFile} from "../prepare-upstream.mjs";

const root = path.resolve(import.meta.dirname, "../../../../../../..");
const [outputArgument, mode = "fixed", coarseSource] = process.argv.slice(2);
if (!outputArgument || !["fixed", "original", "coarse"].includes(mode) || mode === "coarse" && !coarseSource)
  throw new Error("Usage: kernel-parameter-cache.mjs OUTPUT [fixed|original|coarse SOURCE]");
const output = path.resolve(outputArgument);
fs.mkdirSync(output, {recursive: true});
const upstream = fs.readFileSync(path.join(root, "src/external/MLX-DLSS", kernelParametersFile), "utf8");
const source = mode === "fixed" ? patchKernelParameters(upstream) : mode === "coarse" ? fs.readFileSync(coarseSource, "utf8") : upstream;
const start = source.indexOf("enum NeuralRenderingKernelParameters {");
const end = source.indexOf("\n}\n", start) + 2;
if (start < 0 || end < start) throw new Error("The actual kernel parameter cache declaration is unavailable.");
const fixture = fs.readFileSync(path.join(import.meta.dirname, "KernelParameterCacheConcurrency/main.swift"), "utf8")
  .replace("// INSERT_ACTUAL_KERNEL_PARAMETER_CACHE", source.slice(start, end));
const file = path.join(output, "main.swift"), binary = path.join(output, "kernel-parameter-cache-" + mode);
fs.writeFileSync(file, fixture);
const env = {...process.env, TSAN_OPTIONS: "halt_on_error=1:exitcode=66"};
for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_)/.test(key)) delete env[key];
const commands = [["/usr/bin/xcrun", "swiftc", "-swift-version", "6", "-sanitize=thread", "-g", file, "-o", binary], [binary]];
const results = [];
for (const argv of commands) {
  const result = spawnSync(argv[0], argv.slice(1), {env, encoding: "utf8", timeout: argv[0] === binary && mode !== "fixed" ? 5000 : 60000});
  results.push({argv, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr});
  if (result.status !== 0) break;
}
fs.writeFileSync(path.join(output, "RESULT.json"), JSON.stringify({mode, cpuOnly: true, actualCacheCode: true, mockedArrayAllocation: true, results}, null, 2) + "\n");
console.log(JSON.stringify({mode, status: results.at(-1).status, signal: results.at(-1).signal, output}));
if (results.at(-1).status !== 0) process.exitCode = 1;
