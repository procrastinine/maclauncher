'use strict';
const fs = require('node:fs'), path = require('node:path');
const {inspectBinary, machoMagic} = require('../core/binary-arch');
const {throwIfAborted} = require('../modules/shared/runtime/download-utils');
const Upstream = require('../modules/shared/runtime/upstream');
const {hashFile} = require('../modules/shared/runtime/pinned-native-manager');

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function destinationPath(destination) {
  let parent = path.resolve(destination); const missing = [];
  while (!fs.lstatSync(parent, {throwIfNoEntry: false})) { missing.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const existing = fs.realpathSync(parent);
  if (!fs.statSync(existing).isDirectory()) throw new Error('The installation destination has no directory parent.');
  return path.join(existing, ...missing);
}
function measure(root, signal) {
  const base = fs.realpathSync(root), binaries = [];
  let count = 0;
  function walk(relative, ancestors) {
    throwIfAborted(signal);
    if (++count > 250000 || ancestors.size > 128) throw new Error('The runtime payload exceeds inventory bounds.');
    const file = fs.realpathSync(path.join(base, relative));
    if (!within(base, file)) throw new Error('A runtime member is outside its payload.');
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (ancestors.has(file)) throw new Error('The runtime payload contains a directory link cycle.');
      const next = new Set(ancestors); next.add(file);
      for (const name of fs.readdirSync(file).sort()) walk(relative ? relative + '/' + name : name, next);
    } else if (stat.isFile() && stat.size >= 4) {
      const fd = fs.openSync(file, 'r'), header = Buffer.alloc(4);
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (header.readUInt16LE(0) === 0x5a4d || header.readUInt32BE(0) === 0x7f454c46 || machoMagic(header.readUInt32BE(0)))
        binaries.push({path: relative, ...inspectBinary(file)});
    }
  }
  walk('', new Set()); return binaries;
}
function checkCPU(binaries, intended) {
  const cpus = [...new Set(binaries.flatMap(binary => binary.format === 'macho' ? binary.architectures : [binary.machine]))];
  const matches = intended === 'arm64' ? ['arm64', 'arm64ec', 'arm64x', 'aarch64'] : intended === 'x86_64' ? ['x86_64'] : null;
  if (matches && cpus.length && !matches.some(cpu => cpus.includes(cpu)))
    throw new Error('Runtime CPU mismatch: asset intended ' + intended + '; measured ' + cpus.join(', ') + '.');
}
async function publisherVerification(asset, archive, selected, signal, dependencies) {
  const sha256 = hashFile(archive), digest = Upstream.readDigest(asset.sha256 || asset.digest, asset.sha256 ? 'sha256' : undefined);
  if (digest && hashFile(archive, digest.algorithm) !== digest.value) throw new Error('The runtime archive does not match its publisher digest.');
  const filename = asset.filename || asset.name, sidecars = selected.verificationFiles || [];
  const checksum = sidecars.find(file => (file.filename || file.name) === filename + '.sha256') ||
    sidecars.find(file => /^(?:sha256sums?(?:[.]txt)?|checksums[.]txt)$/i.test(file.filename || file.name || ''));
  let sums;
  if (checksum) sums = await require('./verification').verifySumsFile({archiveSha256: sha256, checksum, filename, signal}, dependencies);
  return {archiveSha256: sha256, ...(digest ? {publisherDigest: digest} : {}), ...(sums ? {sums} : {})};
}

// Core has selected this exact build and obtained consent. Installation never
// admits a launch; core reads fresh inventory before applying its final choice.
async function installBuild({build, source, manager, context = {}, installOptions = {}} = {}, dependencies = {}) {
  const sourceId = build?.sourceId || build?.source;
  if (!build || !source || sourceId !== source.id || build.kind !== source.kind) throw new Error('The selected build does not belong to this source.');
  const version = build.legacy?.version || build.version;
  if (!version || installOptions.version !== undefined && installOptions.version !== version) throw new Error('An exact selected runtime version is required.');
  if (installOptions.replace) throw new Error('Installed builds are immutable.');
  const signals = [...new Set([context.signal, installOptions.signal].filter(Boolean))], signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const options = {userDataDir: context.userDataDir, settings: context.settings, downloads: context.downloads, logger: context.logger,
    onProgress: context.onProgress, ...installOptions, version, exactVersion: true, signal};
  const input = {build, source, manager, context, installOptions};
  const install = async () => {
    throwIfAborted(signal);
    if (dependencies.installExact) {
      const installed = await dependencies.installExact({...input, options});
      throwIfAborted(signal);
      if (!installed || installed.version !== version) throw new Error('The backend installation does not match the selected version.');
      return {installed};
    }
    if (!dependencies.prepareInstallation || !dependencies.resolveAsset) throw new Error('The existing managed installation backend is not configured.');
    const selected = await dependencies.resolveAsset({...input, signal}), asset = selected.asset;
    const listed = Upstream.listedFile({...asset, filename: asset.filename || asset.name});
    if (!listed) throw new Error('The selected runtime asset has no HTTPS download.');
    if (build.provenance?.assetUrl && asset.url !== build.provenance.assetUrl) throw new Error('The selected runtime asset changed. Refresh versions.');
    const transaction = await dependencies.prepareInstallation({...input, signal});
    try {
      if (!transaction?.commit || !transaction.rollback) throw new Error('The existing runtime store requires commit and rollback.');
      const directory = transaction.directory;
      if (!path.isAbsolute(directory || '') || fs.lstatSync(directory).isSymbolicLink() || fs.readdirSync(directory).length)
        throw new Error('Runtime staging must be a new empty owned directory.');
      if (!path.isAbsolute(transaction.destination || '') || fs.lstatSync(transaction.destination, {throwIfNoEntry: false}) ||
          within(fs.realpathSync(directory), destinationPath(transaction.destination))) throw new Error('An unused destination outside staging is required.');
      const archive = path.join(directory, listed.name);
      await (dependencies.download || Upstream.download)(listed, archive, {signal, onProgress: options.onProgress});
      throwIfAborted(signal);
      if (!fs.lstatSync(archive).isFile()) throw new Error('The runtime download is not a regular file.');
      if (listed.bytes !== undefined && fs.statSync(archive).size !== listed.bytes) throw new Error('The runtime archive size differs from its publisher record.');
      const verification = await publisherVerification(asset, archive, selected, signal, dependencies);
      const extracted = path.join(directory, 'payload'); fs.mkdirSync(extracted);
      const result = await (dependencies.extractArchive || require('../modules/shared/runtime/safe-archive').extractArchive)(archive, extracted, signal);
      const root = fs.realpathSync(result?.root || extracted);
      if (!within(fs.realpathSync(extracted), root)) throw new Error('The extracted runtime is outside staging.');
      const binaries = measure(root, signal);
      checkCPU(binaries, selected.intendedCPU || build.intendedCPU || build.architecture);
      const measured = {id: build.id, sourceId: source.id, kind: source.kind, version: build.version,
        installed: true, measured: true, root: path.resolve(transaction.destination), binaries,
        ...(build.parent ? {parent: build.parent} : {}), provenance: structuredClone(build.provenance || {})};
      throwIfAborted(signal);
      const installed = await transaction.commit({root, build: measured, verification, asset});
      return {installed, build: measured, verification};
    } catch (error) {
      try { if (transaction?.rollback) await transaction.rollback(error); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  };
  return context.withRuntimeMutation ? context.withRuntimeMutation({managerId: manager?.id || source.id, sectionId: options.sectionId || 'default', version}, install) : install();
}
module.exports = {installBuild};
