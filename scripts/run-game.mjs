import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import electronImport from "electron";

function parseArgs(argv) {
  const out = { debug: false, smoke: false, game: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--debug") out.debug = true;
    else if (a === "--smoke") out.smoke = true;
    else if (a === "--game") out.game = argv[i + 1];
  }
  return out;
}

const { debug, smoke, game } = parseArgs(process.argv.slice(2));
const env = {
  ...process.env,
  MACLAUNCHER_DEBUG: debug ? "1" : process.env.MACLAUNCHER_DEBUG
};
delete env.ELECTRON_RUN_AS_NODE;

const electronPath =
  typeof electronImport === "string"
    ? electronImport
    : electronImport && typeof electronImport.default === "string"
      ? electronImport.default
      : null;

function resolveElectronBinary() {
  const override = process.env.MACLAUNCHER_ELECTRON_PATH;
  if (typeof override === "string" && override.trim()) return override.trim();
  if (electronPath) return electronPath;
  return "electron";
}

function resolveElectronAppPath(binPath) {
  if (!binPath || !path.isAbsolute(binPath)) return null;
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const idx = binPath.indexOf(marker);
  if (idx < 0) return null;
  return binPath.slice(0, idx);
}

function clearQuarantine(appPath) {
  const xattr = fs.existsSync("/usr/bin/xattr") ? "/usr/bin/xattr" : "xattr";
  try {
    spawnSync(xattr, ["-dr", "com.apple.quarantine", appPath], { stdio: "ignore" });
  } catch {}
  try {
    spawnSync(xattr, ["-dr", "com.apple.provenance", appPath], { stdio: "ignore" });
  } catch {}
}

function verifyCodeSign(appPath) {
  const codesign = fs.existsSync("/usr/bin/codesign") ? "/usr/bin/codesign" : "codesign";
  try {
    const res = spawnSync(codesign, ["--verify", "--verbose=4", appPath], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return true;
  }
}

function adHocCodeSign(appPath) {
  const codesign = fs.existsSync("/usr/bin/codesign") ? "/usr/bin/codesign" : "codesign";
  try {
    spawnSync(codesign, ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
  } catch {}
}

function maybeFixElectronCodeSign(binPath) {
  if (process.platform !== "darwin") return;
  if (process.env.MACLAUNCHER_SKIP_ELECTRON_CODESIGN === "1") return;
  if (!binPath || !path.isAbsolute(binPath)) return;
  const appPath = resolveElectronAppPath(binPath);
  if (!appPath || !fs.existsSync(appPath)) return;
  if (!verifyCodeSign(appPath)) {
    adHocCodeSign(appPath);
  }
}

function maybeClearElectronQuarantine(binPath) {
  if (process.platform !== "darwin") return;
  if (process.env.MACLAUNCHER_SKIP_ELECTRON_XATTR === "1") return;
  if (!binPath || !path.isAbsolute(binPath)) return;
  const appPath = resolveElectronAppPath(binPath);
  if (!appPath || !fs.existsSync(appPath)) return;
  clearQuarantine(appPath);
}

const electronArgs = ["."];
if (game) electronArgs.push(`--maclauncher-game=${game}`);
if (smoke) electronArgs.push("--maclauncher-smoke");

const electronBinary = resolveElectronBinary();
maybeClearElectronQuarantine(electronBinary);
maybeFixElectronCodeSign(electronBinary);

const electron = spawn(electronBinary, electronArgs, { stdio: "inherit", env });
electron.on("exit", (code, signal) => {
  if (signal) {
    if (signal === "SIGABRT" && process.platform === "darwin") {
      const appPath = resolveElectronAppPath(electronBinary);
      const hint = appPath
        ? `Try: xattr -dr com.apple.quarantine \"${appPath}\"`
        : "Try clearing quarantine from the MacLauncher.app bundle.";
      console.error(`MacLauncher exited with ${signal}. ${hint}`);
    } else {
      console.error(`MacLauncher exited with ${signal}.`);
    }
    process.exit(1);
  }
  process.exit(code ?? 0);
});
