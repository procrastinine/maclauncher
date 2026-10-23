import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {withGenerationCache,retainGeneration,liveGenerationPaths,generationProcesses,generationReferenced,processAlive} from './generation-cache.mjs';

const require = createRequire(import.meta.url);
const { parsePlistFile, savePlistFile } = require("app-builder-lib/out/util/plist");
const { copyAppBundle, validateAppBundle } = require("../src/modules/shared/runtime/app-bundle");
const { applicationDocumentTypes } = require("../src/core/file-associations");
const Modules = require("../src/modules/registry");
const projectRoot = path.resolve(import.meta.dirname, "..");

export function pruneDevelopmentApps(cacheRoot,current,{processes=generationProcesses(),alive=processAlive}={}){
  if(processes===null)return;
  const paths=liveGenerationPaths(cacheRoot,{alive}),generations=[];
  for(const entry of fs.readdirSync(cacheRoot,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const file=path.join(cacheRoot,entry.name),staging=/^\.prepare-(\d+)-/.exec(entry.name);
    if(staging){if(!alive(Number(staging[1])))fs.rmSync(file,{recursive:true,force:true});continue;}
    if(!/^[a-f0-9]{24}$/.test(entry.name)||!fs.existsSync(path.join(file,'ready.json')))continue;
    generations.push({file,at:fs.statSync(path.join(file,'ready.json')).mtimeMs});
  }
  const fallback=generations.filter(row=>row.file!==current).sort((a,b)=>b.at-a.at)[0]?.file;
  for(const {file}of generations)if(file!==current&&file!==fallback&&!generationReferenced(file,paths,processes))fs.rmSync(file,{recursive:true,force:true});
}

// app.setName changes only Electron's internal name. A separate development
// bundle supplies the macOS identity without changing the installed runtime.
export async function prepareDevelopmentApp({ electronBinary, platform = process.platform,
  cacheRoot = path.join(os.homedir(), "Library", "Caches", "maclauncher", "development"),
  iconPath = path.join(projectRoot, "build", "icon.icns"),
  entitlementsPath = path.join(projectRoot, "build", "entitlements.mac.plist"),
  run = execFileSync } = {}) {
  if (platform !== "darwin" || process.env.MACLAUNCHER_ELECTRON_PATH) return electronBinary;
  const marker = path.sep + "Contents" + path.sep + "MacOS" + path.sep;
  const index = electronBinary?.lastIndexOf(marker);
  if (index == null || index < 0) return electronBinary;
  const source = electronBinary.slice(0, index);
  const infoPath = path.join(source, "Contents", "Info.plist");
  const info = await parsePlistFile(infoPath);
  const documentTypes = applicationDocumentTypes(Modules.listSupportedInputExtensions());
  const digest = crypto.createHash("sha256").update("maclauncher-development-v2-media");
  for (const file of [infoPath, iconPath, entitlementsPath, path.join(source, "Contents", "_CodeSignature", "CodeResources")]) {
    if (fs.existsSync(file)) digest.update(fs.readFileSync(file));
  }
  digest.update(JSON.stringify(documentTypes));
  const identity = digest.digest("hex").slice(0, 24);
  const cache = path.join(cacheRoot, identity);
  const destination = path.join(cache, "MacLauncher.app");
  const executable = path.join(destination, "Contents", "MacOS", "MacLauncher");
  return withGenerationCache(cacheRoot,async()=>{
  const prune=()=>{try{pruneDevelopmentApps(cacheRoot,cache);}catch(error){console.warn('Development cache cleanup: '+error.message);}};
  // The launcher stays alive for its Electron child's lifetime, including the
  // interval between preparing the executable and spawning that child.
  retainGeneration(cacheRoot,[cache]);
  if (fs.existsSync(path.join(cache, "ready.json"))) {
    let valid=true;
    try { validateAppBundle(destination, { executablePath: executable }); } catch(error) {
      valid=false;const processes=generationProcesses();if(processes===null||processes.includes(cache+path.sep))throw error;
    }
    if(valid){prune();return executable;}
  }
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(cacheRoot, ".prepare-"+process.pid+"-"));
  const stagedApp = path.join(staging, "MacLauncher.app");
  try {
    copyAppBundle(source, stagedApp);
    const contents = path.join(stagedApp, "Contents");
    const frameworks = path.join(contents, "Frameworks");
    for (const name of fs.readdirSync(frameworks)) {
      if (!name.startsWith(info.CFBundleName + " Helper") || !name.endsWith(".app")) continue;
      const helper = path.join(frameworks, name);
      const helperInfoPath = path.join(helper, "Contents", "Info.plist");
      const helperInfo = await parsePlistFile(helperInfoPath);
      const suffix = name.slice(info.CFBundleName.length, -4);
      const newName = "MacLauncher" + suffix;
      const helperExecutable = helperInfo.CFBundleExecutable || name.slice(0, -4);
      fs.renameSync(path.join(helper, "Contents", "MacOS", helperExecutable),
        path.join(helper, "Contents", "MacOS", newName));
      helperInfo.CFBundleExecutable = newName;
      helperInfo.CFBundleName = newName;
      helperInfo.CFBundleDisplayName = newName;
      await savePlistFile(helperInfoPath, helperInfo);
      fs.renameSync(helper, path.join(frameworks, newName + ".app"));
    }
    fs.renameSync(path.join(contents, "MacOS", info.CFBundleExecutable), path.join(contents, "MacOS", "MacLauncher"));
    info.CFBundleExecutable = "MacLauncher";
    info.CFBundleName = "MacLauncher";
    info.CFBundleDisplayName = "MacLauncher";
    info.CFBundleIdentifier = "com.maclauncher.launcher.development";
    info.CFBundleIconFile = "icon.icns";
    info.CFBundleDocumentTypes = documentTypes;
    info.NSMicrophoneUsageDescription = "Selected games can record audio from the input chosen in game Settings.";
    info.NSCameraUsageDescription = "Selected games can receive video from the camera chosen in game Settings.";
    fs.copyFileSync(iconPath, path.join(contents, "Resources", "icon.icns"));
    await savePlistFile(path.join(contents, "Info.plist"), info);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--entitlements", entitlementsPath, stagedApp], { stdio: "pipe", timeout: 120000 });
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp], { stdio: "pipe", timeout: 60000 });
    validateAppBundle(stagedApp);
    fs.writeFileSync(path.join(staging, "ready.json"), JSON.stringify({ identity, electronVersion: info.CFBundleShortVersionString }) + "\n", { mode: 0o600 });
    if (fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true });
    fs.renameSync(staging, cache);
    prune();
    return executable;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  });
}
