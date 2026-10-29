const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");
const { profile, environment, canonical, isolateGraphics } = require("../shared/runtime/macos-sandbox");
const { resolveStorageHelper } = require("./runtime/storage-helper");
async function prepareSandbox({ launch, root, graphics = {}, blockNetwork = true, signal }) {
  const owner = await canonical(root, "directory"), executable = await canonical(launch.executablePath, "file"), app = await canonical(launch.appRoot, "directory");
  if (!app.startsWith(owner + path.sep) || !executable.startsWith(app + path.sep)) throw new Error("Prepared iOS application escaped its private directory.");
  const data = path.join(owner, "data"), home = path.join(data, "home"), temporary = path.join(data, "tmp"), output = path.join(data, "graphics"), inputs = path.join(owner, "graphics");
  for (const directory of [data, home, temporary, output, inputs]) Writable.assertOwnDirectory(owner, directory);
  const playToolsRoot = path.join(home, "Library/Containers/io.playcover.PlayCover");
  Writable.assertOwnDirectory(owner, playToolsRoot);
  const scoped = await isolateGraphics(graphics, inputs, output, signal);
  const readDirectories = [app, await canonical(inputs, "directory"), ...scoped.readableDirectories], readFiles = [...scoped.readable];
  // Only explicitly injected, selected native adapters are readable. No game
  // directory, general runtime store or user-selected shader folder is granted.
  const libraries = [...new Set(await Promise.all([resolveStorageHelper(), ...(scoped.graphics.DYLD_INSERT_LIBRARIES || "").split(path.delimiter).filter(Boolean)]
    .map(file => canonical(file, "file"))))];
  if (libraries.length > 16) throw new Error("Too many native graphics adapters.");
  readFiles.push(...libraries);
  const envTool = await canonical("/usr/bin/env", "file");
  // UIKit's Catalyst scene coordinator is additional to AppKit's window
  // services. These names come from Apple's application.sb UIKit policy.
  const text = profile({ readDirectories, readFiles, writeDirectories: [data], executables: [executable, envTool,...(scoped.executables||[])], blockNetwork,
    machServices: ["com.apple.frontboard.systemappservices", "com.apple.frontboard.workspace", "com.apple.runningboard", "com.apple.uikitsystemapp.services"],fileExtensions:scoped.fileExtensions })+(scoped.capabilities||"");
  const file = path.join(owner, "sandbox.sb"); Writable.atomicWrite(file, text, { root: owner });
  // sandbox-exec is an Apple protected executable and strips DYLD variables.
  // Set the selected adapter after entering the sandbox, before execing the app.
  return { command: "/usr/bin/sandbox-exec", args: ["-f", file, ...(libraries.length ? [envTool, "DYLD_INSERT_LIBRARIES=" + libraries.join(path.delimiter)] : []), executable],
    graphics: scoped.graphics,
    environment: { ...environment(), ...scoped.graphics, ...(libraries.length ? { DYLD_INSERT_LIBRARIES: libraries.join(path.delimiter) } : {}),
      HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary + path.sep, MACLAUNCHER_PLAYTOOLS_ROOT: playToolsRoot,
      MACLAUNCHER_IOS_VENDOR_ID: require("./identity").vendorIdentifier(owner) }, profile: text };
}
module.exports = { prepareSandbox };
