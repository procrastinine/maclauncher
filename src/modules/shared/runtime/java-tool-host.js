const Java = require("../../java/runtime/java-runtime-manager");
const Rosetta = require("./rosetta");
const { confirmToolInstall } = require("./tool-install");
const { throwIfAborted } = require("./download-utils");

// Java inspectors share the managed Temurin installations used by Java games.
async function ensure(context, minimumJava = 17, dependencies = {}) {
  const manager = dependencies.manager || Java, core = manager.core.java;
  const config = manager.normalizeSettings(context.settings?.runtimes?.java);
  const lines = [...new Set([config.defaultLine, ...core.LTS_LINES])]
    .filter(line => core.LTS_LINES.includes(line) && line >= minimumJava);
  if (!lines.length) throw new Error(`This tool requires Java ${minimumJava}, which is not available from the managed Java catalog.`);
  const resolve = (line, version) => core.resolveBestInstalled({ userDataDir: context.userDataDir, line, version,
    variant: config.lines[line].defaultVariant, hostArch: process.arch });
  let host;
  for (const line of lines) {
    host = resolve(line, config.lines[line].defaultVersion) || resolve(line, null);
    if (host) break;
  }
  if (!host) {
    const line = lines[0], variant = config.lines[line].defaultVariant;
    let version = config.lines[line].defaultVersion;
    if (!version) {
      await manager.refreshCatalog({ sectionId: String(line), force: false, latestOnly: false,
        logger: context.logger, signal: context.signal });
      context.onRuntimeStateChange?.();
      version = manager.getState({ userDataDir: context.userDataDir, settings: config }).sections
        .find(section => section.id === String(line))?.catalog?.versions?.[0];
    }
    if (!version) throw new Error(`No Java ${line} runtime is available for this tool.`);
    const installOptions = { sectionId: String(line), line, variant };
    await confirmToolInstall(context, { manager, version, installOptions, label: `Java ${line}`,
      requiresDownload: true, detail: "Required to run this game tool." });
    await manager.installRuntime({ ...context, ...installOptions, version });
    context.onRuntimeStateChange?.();
    host = resolve(line, version);
    if (!host?.javaPath) throw new Error("The Java tool host could not be installed.");
  }
  throwIfAborted(context.signal);
  if (host.requiresRosetta && !core.isRosettaAvailable()) {
    if (typeof context.ensureRosetta === "function") await context.ensureRosetta();
    else await Rosetta.ensure(context);
    if (!core.isRosettaAvailable()) throw Rosetta.createRequiredError();
  }
  return { ...host, runtimeIdentity: { managerId: manager.id, version: host.version,
    sectionId: String(host.line), variant: host.variant, sourcePath: host.installDir || host.javaHome || host.javaPath } };
}

module.exports = { ensure };
