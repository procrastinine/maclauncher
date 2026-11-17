const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Format = require("./freearc-format");
const Codecs = require("./freearc-codecs");
const Streams = require("./freearc-stream");
const { runHelper } = require("./process");
const { installerError } = require("./inno-header");
const Manager = require("./runtime/freearc-manager");
const ABI = "freearc-managed-srep-v3";
async function toolsFor(context) {
  if (context.freeArcTools) return context.freeArcTools;
  let install;
  if (context.readOnly) {
    const selection = Manager.resolveSelection(context.entry, context.settings, context.userDataDir);
    if (!selection.ready) throw installerError("The FreeArc decoders are unavailable for this cached extraction.", "INSTALLER_TOOL_MISSING");
    install = selection.install;
  } else install = await Manager.ensure(context.entry, {}, context);
  const root = install.installDir;
  const tools = Object.fromEntries(["filter", "clsHost"].map(name => {
    const relative = install.runtimeFiles?.[name];
    if (typeof relative !== "string" || Format.safePath(relative) !== relative) throw installerError("The FreeArc decoder package is incomplete.", "INSTALLER_TOOL_MISSING");
    return [name, path.join(root, relative)];
  }));
  const manifest = install.manifest;
  if (!manifest?.files || !install.payloadRoot) throw installerError("The FreeArc decoder package has no verified file manifest.", "INSTALLER_TOOL_MISSING");
  const identities = [];
  for (const file of Object.values(tools)) {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2) throw installerError("The FreeArc decoder package contains an invalid helper.");
    const relative = path.relative(install.payloadRoot, file).split(path.sep).join("/");
    const record = manifest.files.find(record => record.path === relative);
    if (!record || record.size !== stat.size || !/^[a-f0-9]{64}$/.test(record.sha256 || "")) throw installerError("The FreeArc decoder package manifest is incomplete.", "INSTALLER_TOOL_MISSING");
    identities.push(record.sha256);
  }
  const srep = require("./runtime/srep-manager").selectedForInstaller(context);
  if (srep) { tools.srep = srep.install.executablePath; identities.push(srep.install.binarySha256 || srep.install.sha256); }
  return { ...tools, identity: crypto.createHash("sha256").update(JSON.stringify([ABI, install.version, identities])).digest("hex") };
}
async function needsSrep(archives, tools, context) {
  for (const archive of archives) {
    const blocks = await Format.mapArchive(archive, { signal: context.signal,
      decode: (method, input, size) => Streams.decodeControl(method, input, size, tools, context) });
    if (blocks.some(block => /(?:^|[+:])srep(?=[:+]|$)/i.test(block.method))) return true;
  }
  return false;
}
async function inspectShell(root, { allowMissing = false } = {}) {
  let bytes = 0, count = 0; const configurations = [];
  async function walk(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); Format.safePath(path.relative(root, file));
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw installerError("The installer decoder payload contains an unsafe entry.");
      if (stat.isDirectory()) { await walk(file); continue; }
      if (++count > 10000 || (bytes += stat.size) > 1024 ** 3) throw installerError("The installer decoder payload exceeds its size limit.");
      if (entry.name.toLowerCase() === "arc.ini") configurations.push(file);
    }
  }
  await walk(root);
  if (!configurations.length && allowMissing) return null;
  if (configurations.length !== 1) throw installerError("The FreeArc installer needs one decoder configuration in its temporary payload.");
  const stat = await fs.promises.lstat(configurations[0]); if (stat.size > 1024 ** 2) throw installerError("The FreeArc decoder configuration exceeds its size limit.");
  const helpers = path.dirname(configurations[0]), ini = Codecs.parseIni(await fs.promises.readFile(configurations[0], "utf8"));
  const files = (await fs.promises.readdir(helpers, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name);
  if (new Set(files.map(f => f.toLowerCase())).size !== files.length) throw installerError("The installer decoder payload has conflicting file names.");
  return { helpers, ini, files };
}
async function stageShell(file, stage, helper, context) {
  const shell = path.join(stage, "decoder-shell"); await fs.promises.mkdir(shell);
  await runHelper(helper.executable, ["--extract", "--silent", "--progress=false", "--color=false", "--collisions=error", "--include", "tmp", "--output-dir", shell, file],
    { signal: context.signal, timeout: 3600000, maximum: 65536, onSpawn: context.onSpawn });
  return inspectShell(shell, { allowMissing: true });
}
async function prepare(file, archives, stage, helper, tools, context, payload) {
  payload ||= await stageShell(file, stage, helper, context);
  if (!payload) return null;
  const work = path.join(stage, "decoder-work"); await fs.promises.mkdir(work);
  const mapped = [];
  for (const archive of archives) {
    const blocks = await Format.mapArchive(archive, { signal: context.signal, decode: (method, input, size) => Streams.decodeControl(method, input, size, tools, { ...context, work }) });
    mapped.push({ path: archive, blocks: blocks.map(block => ({ ...block, stages: Codecs.planChain(block.method, payload.ini, payload.files, tools) })) });
  }
  const files = mapped.flatMap(a => a.blocks.flatMap(b => b.files)); Format.validateFiles(files);
  return { archives: mapped, files, work, helpers: payload.helpers, requiresWine: mapped.some(a => a.blocks.some(b => Codecs.needsWine(b.stages))) };
}
async function extract(plan, output, tools, context, selectedWine) {
  const controller = new AbortController(), abort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", abort, { once: true }); if (context.signal?.aborted) abort();
  let ready, session, release, failure;
  const finished = new Promise(resolve => { release = resolve; });
  const getWine = () => {
    ready ||= new Promise((resolve, reject) => {
      session = require("./freearc-wine").withPrivateWine(scope, plan.work, plan.helpers, async wine => {
        resolve(wine); await finished;
      }, { host: selectedWine }).catch(error => { reject(error); throw error; });
      session.catch(() => {});
    });
    return ready;
  };
  const scope = { ...context, signal: controller.signal, abort: reason => controller.abort(reason), tools, work: plan.work, getWine };
  try {
    for (const archive of plan.archives) for (const block of archive.blocks) await Streams.extractBlock(archive.path, block, block.stages, output, scope);
  } catch (error) { failure = error; controller.abort(error); throw error; }
  finally {
    controller.abort(); release(); context.signal?.removeEventListener("abort", abort);
    try { await session; } catch (error) { if (!failure) throw error; }
    finally {
      // Decoder binaries and disposable Windows state are never game payloads.
      await fs.promises.rm(path.join(path.dirname(plan.work), "decoder-shell"), { recursive: true, force: true });
      await fs.promises.rm(plan.work, { recursive: true, force: true });
    }
  }
}
module.exports = { ABI, toolsFor, needsSrep, inspectShell, stageShell, prepare, extract, findArchives: Format.findArchives };
