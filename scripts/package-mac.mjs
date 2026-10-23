import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, { stdio: "inherit", env });
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

const env = { ...process.env, FORCE_COLOR: "1" };
const incomingArgs = process.argv.slice(2);
const extraArgs = [];
const nativeOptions = {};
for (let index = 0; index < incomingArgs.length; index += 1) {
  const argument = incomingArgs[index];
  if (argument === "--") continue;
  if (["--runtime-only", "--runtime-maximum-macos", "--runtime-sign-identity", "--runtime-inventory"].includes(argument)) {
    const value = incomingArgs[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    nativeOptions[argument] = value;
  } else extraArgs.push(argument);
}
const architectures = extraArgs.includes("--universal") ? ["arm64", "x64"] :
  [...new Set([extraArgs.includes("--arm64") && "arm64", extraArgs.includes("--x64") && "x64"].filter(Boolean))];
if (!architectures.length) architectures.push(process.arch);
if (nativeOptions["--runtime-only"]) throw new Error("A MacLauncher app build requires the complete runtime distribution plan.");
const signedBuild = hasDeveloperIdIdentity(env);
const maximumMacOS = nativeOptions["--runtime-maximum-macos"] ||
  JSON.parse(readFileSync(new URL("../build/runtime-packages.json", import.meta.url), "utf8")).maximumMacOS;
const nativeIdentity = nativeOptions["--runtime-sign-identity"] || env.MACLAUNCHER_RUNTIME_SIGN_IDENTITY || env.CSC_NAME;
if (signedBuild && !nativeIdentity) {
  throw new Error("Set MACLAUNCHER_RUNTIME_SIGN_IDENTITY to the identity used by stage-native-runtimes.cjs before a signed package build. See docs/runtimes/RUNTIME_DISTRIBUTION.md.");
}
// Verify published resources before starting an expensive app build. Missing
// architectures, dependencies or stale post-sign hashes fail with setup guidance.
for (const arch of architectures) {
  const args = ["scripts/check-packaging.cjs", "source", "--arch", arch,
    "--maximum-macos", maximumMacOS];
  if (nativeIdentity) args.push("--sign-identity", nativeIdentity);
  if (nativeOptions["--runtime-inventory"]) args.push("--inventory", nativeOptions["--runtime-inventory"]);
  run(process.execPath, args, env);
}

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
run("electron-builder", ["--mac", "--publish=never", ...fallbackSigning, ...extraArgs], builderEnv);
