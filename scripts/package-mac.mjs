import { spawnSync } from "node:child_process";

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
const extraArgs = process.argv.slice(2);

run("npm", ["run", "build"], env);
const builderEnv = { ...env };
if (!hasDeveloperIdIdentity(builderEnv)) {
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  console.log(
    "[package:mac] Developer ID Application identity not found; building unsigned app."
  );
}

run("electron-builder", ["--mac", "--publish=never", ...extraArgs], builderEnv);
