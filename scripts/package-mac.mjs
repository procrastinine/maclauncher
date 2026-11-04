import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, { stdio: "inherit", env });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function hasDeveloperIdIdentity(env) {
  if (env.CSC_LINK || env.CSC_NAME) return true;
  if (
    env.CSC_IDENTITY_AUTO_DISCOVERY &&
    env.CSC_IDENTITY_AUTO_DISCOVERY.toLowerCase() !== "true"
  ) {
    return false;
  }
  if (process.platform !== "darwin") return false;

  const res = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8"
  });
  if (res.error || res.status !== 0) return false;

  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return /Developer ID Application:/i.test(output);
}

const env = { ...process.env };
if (!Object.hasOwn(env, "NO_COLOR") && !Object.hasOwn(env, "FORCE_COLOR")) env.FORCE_COLOR = "1";
const incomingArgs = process.argv.slice(2);
const extraArgs = [];
const nativeOptions = {};
for (let index = 0; index < incomingArgs.length; index += 1) {
  const argument = incomingArgs[index];
  if (argument === "--") continue;
  if (["--runtime-maximum-macos"].includes(argument)) {
    const value = incomingArgs[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    nativeOptions[argument] = value;
  } else extraArgs.push(argument);
}
// Apple Silicon and Intel are separate apps, each with the included packages
// and embedded Python for its own processor, so one run builds one of them.
if (extraArgs.includes("--universal")) throw new Error("MacLauncher ships separate Apple Silicon and Intel apps. Package --arm64 or --x64.");
const architectures = [extraArgs.includes("--arm64") && "arm64", extraArgs.includes("--x64") && "x64"].filter(Boolean);
if (architectures.length > 1) throw new Error("Package one architecture per run: --arm64 or --x64.");
if (!architectures.length) { architectures.push(process.arch); extraArgs.push("--" + process.arch); }
const signedBuild = hasDeveloperIdIdentity(env);
const maximumMacOS = nativeOptions["--runtime-maximum-macos"] ||
  JSON.parse(readFileSync(new URL("../build/runtime-packages.json", import.meta.url), "utf8")).maximumMacOS;
run(process.execPath, ["src/modules/catsystem2/runtime/stage-cp932.cjs"], env);

const require = createRequire(import.meta.url), repoRoot = path.resolve(import.meta.dirname, "..");
await require("./published-inputs.cjs").prepareSevenZip({ repoRoot });
await require("./published-inputs.cjs").prepareDeclaredPublishers({ repoRoot });
for (const arch of architectures) await require("./ci-macos.cjs").preparePython({ repoRoot, arch });

run("pnpm", ["run", "build"], env);
const builderEnv = { ...env };
builderEnv.MACLAUNCHER_NATIVE_MAXIMUM_MACOS = maximumMacOS;
if (!signedBuild) {
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  console.log(
    "[package:mac] Developer ID Application identity not found; using an ad hoc signature."
  );
}

const fallbackSigning = !signedBuild && !extraArgs.some(argument => argument.startsWith("--config.mac.identity"))
  ? ["--config.mac.identity=-"] : [];
run("pnpm", ["exec", "electron-builder", "--mac", "--publish=never", ...fallbackSigning, ...extraArgs], builderEnv);
