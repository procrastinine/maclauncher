// Developer-only recipe. Game actions use the reviewed bundled executable.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const PIN = Object.freeze(require("./decrypter-source.json"));
const PROPS = path.join(__dirname, "decrypter-build.props");
const TARGETS = path.join(__dirname, "decrypter-build.targets");
const PROJECTS = ["RPGMakerDecrypter.Cli", "RPGMakerDecrypter.Common", "RPGMakerDecrypter.MVMZ", "RPGMakerDecrypter.RGSSAD"];
const LOCK_ROOT = path.join(__dirname, "decrypter-locks");
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function assertArchive(file, pin) {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || sha256(file) !== pin.sha256)
    throw new Error("The selected build archive does not match its reviewed checksum.");
}
function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
function assertNewOutput(outputDir, inputs) {
  if (!path.isAbsolute(outputDir) || /[\r\n]/.test(outputDir) || fs.existsSync(outputDir))
    throw new Error("Choose a new absolute owned build directory.");
  const parent = fs.realpathSync(path.dirname(outputDir));
  const actual = path.join(parent, path.basename(outputDir));
  for (const input of inputs) {
    const original = fs.realpathSync(input);
    if (contained(original, actual) || contained(actual, original))
      throw new Error("Build output must be separate from its source and SDK inputs.");
  }
  if (actual.split(path.sep).includes("external")) throw new Error("Build output cannot be a vendored source directory.");
  return actual;
}
function verifySource(sourcePath) {
  const root = fs.realpathSync(sourcePath);
  for (const file of PIN.files) {
    const full = path.join(root, file.path);
    if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full || sha256(full) !== file.sha256)
      throw new Error("Pinned decrypter source input changed: " + file.path);
  }
  return root;
}
function prepareSource({ sourcePath, outputDir, includeLocks = true }) {
  const original = verifySource(sourcePath);
  const owned = assertNewOutput(outputDir, [original]);
  fs.mkdirSync(owned);
  for (const file of PIN.files) {
    const target = path.join(owned, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(original, file.path), target);
  }
  fs.copyFileSync(PROPS, path.join(owned, "Directory.Build.props"));
  fs.copyFileSync(TARGETS, path.join(owned, "Directory.Build.targets"));
  if (includeLocks) for (const project of PROJECTS)
    fs.copyFileSync(path.join(LOCK_ROOT, project + ".json"), path.join(owned, project, "packages.lock.json"));
  return { sourcePath: owned, upstreamRevision: PIN.source.revision,
    sourceArchiveSha256: PIN.source.sha256, propertiesSha256: sha256(PROPS) };
}
function buildEnvironment(buildRoot, packageRoot) {
  return { ...process.env, DOTNET_CLI_HOME: path.join(buildRoot, "dotnet-user"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "true", DOTNET_MULTILEVEL_LOOKUP: "0",
    NUGET_PACKAGES: packageRoot, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
}
function publishArguments(project, publishRoot) {
  return ["publish", project, "--no-restore", "--configuration", "Release", "--runtime", PIN.runtimeIdentifier,
    "--self-contained", "true", "--output", publishRoot,
    "-p:MinVerSkip=true", "-p:Version=3.0.0-dev.465c88c3", "-p:InformationalVersion=" + PIN.informationalVersion,
    "-p:DebugType=none", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true"];
}
function verifyPackageArchives(packageRoot) {
  for (const pin of PIN.packages) {
    const archive = path.join(packageRoot, pin.name, pin.version, pin.name + "." + pin.version + ".nupkg");
    assertArchive(archive, pin);
  }
  return Object.fromEntries(PIN.packages.map(pin => [pin.name + "/" + pin.version, pin.sha256]));
}
function buildTool({ sourceArchive, sdkArchive, outputDir, packageRoot, offline = false, logPath }) {
  assertArchive(sourceArchive, PIN.source); assertArchive(sdkArchive, PIN.sdk);
  const owned = assertNewOutput(outputDir, [sourceArchive, sdkArchive]); fs.mkdirSync(owned);
  const extracted = path.join(owned, "input"); fs.mkdirSync(extracted);
  execFileSync("/usr/bin/tar", ["-xzf", sourceArchive, "-C", extracted]);
  const input = path.join(extracted, "RPGMakerDecrypter-" + PIN.source.revision);
  const source = prepareSource({ sourcePath: input, outputDir: path.join(owned, "source") });
  const sdk = path.join(owned, "sdk"); fs.mkdirSync(sdk);
  execFileSync("/usr/bin/tar", ["-xzf", sdkArchive, "-C", sdk]);
  const packages = packageRoot ? fs.realpathSync(packageRoot) : path.join(owned, "packages");
  const env = buildEnvironment(owned, packages), dotnet = path.join(sdk, "dotnet");
  const version = execFileSync(dotnet, ["--version"], { cwd: source.sourcePath, env, encoding: "utf8" }).trim();
  if (version !== PIN.sdk.version) throw new Error("Extracted SDK version does not match its pin.");
  const project = path.join(source.sourcePath, "RPGMakerDecrypter.Cli", "RPGMakerDecrypter.Cli.csproj");
  const publishRoot = path.join(owned, "publish"), log = logPath ? fs.openSync(logPath, "a", 0o600) : null;
  try {
    const stdio = log == null ? "inherit" : ["ignore", log, log];
    execFileSync(dotnet, ["restore", project, "--locked-mode", "--runtime", PIN.runtimeIdentifier,
      "--source", offline ? packages : "https://api.nuget.org/v3/index.json", "-p:MinVerSkip=true"],
    { cwd: source.sourcePath, env, stdio, timeout: 180000 });
    verifyPackageArchives(packages);
    execFileSync(dotnet, publishArguments(project, publishRoot),
      { cwd: source.sourcePath, env, stdio, timeout: 180000 });
  } finally { if (log != null) fs.closeSync(log); }
  const executable = path.join(publishRoot, "RPGMakerDecrypter-cli");
  if (!fs.statSync(executable).isFile()) throw new Error("The build did not produce the reviewed CLI.");
  fs.copyFileSync(path.join(input, "LICENSE.txt"), path.join(publishRoot, "LICENSE-RPGMakerDecrypter.txt"));
  for (const name of ["LICENSE.txt", "ThirdPartyNotices.txt"]) {
    const notice = path.join(sdk, name);
    if (!fs.existsSync(notice)) throw new Error("SDK runtime notice is missing.");
    fs.copyFileSync(notice, path.join(publishRoot, "DOTNET-" + name));
  }
  for (const [name, file] of [["commandlineparser", "License.md"], ["newtonsoft.json", "LICENSE.md"]]) {
    const pin = PIN.packages.find(item => item.name === name);
    fs.copyFileSync(path.join(packages, name, pin.version, file), path.join(publishRoot, "LICENSE-" + name + ".md"));
  }
  const lockSha256 = Object.fromEntries(PROJECTS.map(project => [project, sha256(path.join(LOCK_ROOT, project + ".json"))]));
  const record = { schemaVersion: 1, profile: PIN.profile, version: PIN.informationalVersion,
    source: PIN.source, sdk: PIN.sdk, runtimeIdentifier: PIN.runtimeIdentifier,
    propertiesSha256: source.propertiesSha256, targetsSha256: sha256(TARGETS), recipeSha256: sha256(__filename), lockSha256,
    packageArchiveSha256: Object.fromEntries(PIN.packages.map(pin => [pin.name + "/" + pin.version, pin.sha256])),
    deterministic: true, debugSymbols: false, sourcePathMap: "/_/RPGMakerDecrypter",
    parentGitVersionIgnored: true, executableSha256: sha256(executable) };
  fs.writeFileSync(path.join(publishRoot, "build.json"), JSON.stringify(record, null, 2) + "\n");
  return { executable, publishRoot, record };
}
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offline") options.offline = true;
    else {
      const key = { "--source-archive": "sourceArchive", "--sdk-archive": "sdkArchive", "--output": "outputDir", "--packages": "packageRoot", "--log": "logPath" }[args[i]];
      if (!key || !args[i + 1]) throw new Error("Unknown or incomplete build option.");
      options[key] = path.resolve(args[++i]);
    }
  }
  if (![options.sourceArchive, options.sdkArchive, options.outputDir].every(Boolean))
    throw new Error("Usage: decrypter-build.js --source-archive source.tar.gz --sdk-archive sdk.tar.gz --output new-directory [--offline --packages cache]");
  const result = buildTool(options); process.stdout.write(JSON.stringify(result.record, null, 2) + "\n");
}
module.exports = { PIN, PROJECTS, assertArchive, assertNewOutput, verifySource, prepareSource, buildEnvironment, publishArguments, verifyPackageArchives, buildTool };
