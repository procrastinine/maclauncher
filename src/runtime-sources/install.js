'use strict';
const fs = require('node:fs'), path = require('node:path');
const {validateSource, validateBuild} = require('./schema');
const {measureBuild} = require('./installed-build');
const {verifySource} = require('./verification');
const {machoMagic} = require('../core/binary-arch');
const {throwIfAborted} = require('../modules/shared/runtime/download-utils');
const Upstream = require('../modules/shared/runtime/upstream');

function selectedOptions(build, context, installOptions) {
  const version = build.legacy?.version || build.version;
  if (installOptions.version !== undefined && installOptions.version !== version)
    throw new Error('The installation version differs from the selected build.');
  if (installOptions.replace) throw new Error('Installed builds are immutable; replacement is not supported here.');
  const signals = [...new Set([context.signal, installOptions.signal].filter(Boolean))];
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  return {userDataDir: context.userDataDir, settings: context.settings, downloads: context.downloads,
    logger: context.logger, onProgress: context.onProgress, ...installOptions, version, exactVersion: true, signal};
}

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function payloadPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') ||
      relative.includes('\0') || relative.split('/').includes('..'))
    throw new Error('An installation member must be payload-relative.');
  const result = fs.realpathSync(path.join(root, relative));
  if (!within(root, result)) throw new Error('An installation member is outside its payload.');
  return result;
}

// Read code headers throughout the bounded payload, including contained aliases.
// Filename extensions and directory names never establish a binary architecture.
function inventory(root, signal) {
  const files = [], directories = [''];
  let count = 0;
  function walk(relative, ancestors) {
    throwIfAborted(signal);
    if (++count > 250000 || ancestors.size > 128) throw new Error('The runtime payload exceeds inventory bounds.');
    const absolute = relative ? payloadPath(root, relative) : root, stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      if (ancestors.has(absolute)) throw new Error('The runtime payload contains a directory link cycle.');
      const next = new Set(ancestors); next.add(absolute);
      if (relative) directories.push(relative);
      for (const name of fs.readdirSync(absolute).sort()) walk(relative ? relative + '/' + name : name, next);
    } else if (stat.isFile()) {
      if (stat.size < 4) return;
      const fd = fs.openSync(absolute, 'r'), header = Buffer.alloc(4);
      try { if (fs.readSync(fd, header, 0, 4, 0) !== 4) throw new Error('A runtime member changed during inventory.'); }
      finally { fs.closeSync(fd); }
      if (header.readUInt16LE(0) === 0x5a4d || header.readUInt32BE(0) === 0x7f454c46 || machoMagic(header.readUInt32BE(0))) files.push(relative);
    } else throw new Error('The runtime payload contains an unsupported filesystem member.');
  }
  walk('', new Set());
  return {files, directories};
}

function requireParts(root, parts) {
  for (const part of parts) {
    try { payloadPath(root, part.path); }
    catch (error) {
      // An optional absent member is allowed; an escaping or broken link is not.
      if (part.optional && error.code === 'ENOENT' && !fs.lstatSync(path.join(root, part.path), {throwIfNoEntry: false})) continue;
      throw new Error('Required runtime part ' + part.path + ' could not be verified: ' + error.message, {cause: error});
    }
  }
}

function sameDeclarations(left, right) {
  const normalize = value => JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([format, arches]) => [format, [...new Set(arches)].sort()])));
  return normalize(left) === normalize(right);
}

function assetDeclaration(source, build, asset) {
  const name = asset?.filename || asset?.name;
  if (typeof name !== 'string' || path.basename(name) !== name || name.includes('\\') || name.includes('\0'))
    throw new Error('The selected runtime asset has no safe filename.');
  const matches = (source.assets || []).filter(rule => new RegExp(rule.match).test(name));
  if (matches.length !== 1) throw new Error('A unique source declaration is required for the selected asset.');
  const declaration = matches[0], version = new RegExp(declaration.match).exec(name)?.groups?.version;
  if (version && version !== build.version) throw new Error('The asset version differs from the selected build.');
  if (!sameDeclarations(declaration.declares, build.declares)) throw new Error('The selected asset architecture declaration changed; fresh discovery is required.');
  if (build.provenance?.assetUrl && build.provenance.assetUrl !== asset.url)
    throw new Error('The asset URL differs from the selected build.');
  return declaration;
}

function selectRoot(extracted, layout, signal) {
  let root = fs.realpathSync(extracted);
  for (let index = 0; index < (layout.strip || 0); index++) {
    const members = fs.readdirSync(root);
    if (members.length !== 1 || !fs.lstatSync(path.join(root, members[0])).isDirectory())
      throw new Error('Archive strip requires a single directory at every stripped level.');
    root = payloadPath(root, members[0]);
  }
  if (layout.root !== undefined) {
    const matches = inventory(root, signal).directories.filter(relative => new RegExp(layout.root).test(relative));
    if (matches.length !== 1) throw new Error('The archive layout requires one matching payload root.');
    root = matches[0] ? payloadPath(root, matches[0]) : root;
  }
  return root;
}

function measuredRecord({source, build, root, declaration, signal}) {
  const parts = structuredClone(declaration?.parts || build.parts || []);
  if (source.layout.entry) requireParts(root, [{path: source.layout.entry}]);
  requireParts(root, parts);
  for (const embed of source.embeds || []) requireParts(root, embed.parts);
  const files = inventory(root, signal).files;
  if (source.layout.entry && !files.includes(path.posix.normalize(source.layout.entry)))
    throw new Error('The declared process entry is not a measured code file.');
  const measured = measureBuild({source, root, files,
    declares: declaration?.declares || build.declares, id: build.id, version: build.version,
    provenance: build.provenance, parent: build.parent, parts});
  measured.interfaces = {
    provides: [...new Set([...(source.interfaces?.provides || []), ...(declaration?.interfaces?.provides || [])])],
    requires: [...new Set([...(source.interfaces?.requires || []), ...(declaration?.interfaces?.requires || []), ...(build.interfaces?.requires || [])])]
  };
  if (declaration?.reach) measured.reach = structuredClone(declaration.reach);
  // Signature receipts are stored separately. They never turn source claims
  // into measured process-entitlement capabilities.
  return validateBuild(measured);
}

async function localInstallation(input, dependencies, options) {
  const {build, source, context} = input;
  if (typeof dependencies.registerLocal !== 'function') throw new Error('Read-only local application registration is not configured.');
  if (source.verify.some(rule => !['codesign', 'archive-sums'].includes(rule.type)))
    throw new Error('Archive verification cannot be applied to a local application.');
  if (source.layout.strip !== undefined || source.layout.root !== undefined)
    throw new Error('Archive layout transforms are unsupported for local applications.');
  if (!path.isAbsolute(options.localPath || '')) throw new Error('An exact selected local application path is required.');
  const root = fs.realpathSync(options.localPath);
  const verification = await verifySource({source, root, signal: options.signal}, dependencies);
  const measured = measuredRecord({source, build, root, signal: options.signal});
  throwIfAborted(options.signal);
  const installed = await dependencies.registerLocal({...input, root, build: measured, verification, signal: options.signal});
  return {installed, build: measured, verification};
}

async function genericInstallation(input, dependencies, options) {
  const {build, source} = input, signal = options.signal;
  if (source.verify.some(rule => rule.type === 'codesign') && typeof dependencies.verifyCodeSignature !== 'function')
    throw new Error('Strict code-signature verification is not configured.');
  if (source.discover.type === 'local-app' && source.layout.type === 'local-app') return localInstallation(input, dependencies, options);
  if (source.discover.type !== 'github-releases') throw new Error('This transport requires its existing managed backend.');
  if (!['archive', 'pkg', 'app-bundle'].includes(source.layout.type)) throw new Error('The generic installation layout is unsupported.');
  if (!source.verify.length) throw new Error('Generic publisher verification is not configured; use the existing managed backend.');
  if (source.layout.type === 'app-bundle' && (source.layout.keepSigned !== true || typeof dependencies.extractSignedBundle !== 'function'))
    throw new Error('Preserving signed app-bundle extraction is not configured.');
  if (source.layout.type === 'app-bundle' && (source.layout.strip !== undefined || source.layout.root !== undefined))
    throw new Error('Archive layout transforms are unsupported for signed application bundles.');
  if (typeof dependencies.resolveAsset !== 'function' || typeof dependencies.prepareInstallation !== 'function')
    throw new Error('Exact asset binding and an existing-store installation transaction are required.');
  const selected = await dependencies.resolveAsset({...input, signal});
  throwIfAborted(signal);
  const declaration = assetDeclaration(source, build, selected?.asset), asset = selected.asset;
  const listed = Upstream.listedFile({...asset, filename: asset.filename || asset.name});
  if (!listed) throw new Error('The selected asset has no supported HTTPS transport.');
  const format = require('../modules/shared/runtime/safe-archive').ARCHIVE;
  if (source.layout.type === 'pkg' ? !/\.pkg$/i.test(listed.name) : !format.test(listed.name) || /\.pkg$/i.test(listed.name))
    throw new Error('The selected asset format does not match its declared layout.');
  const transaction = await dependencies.prepareInstallation({...input, signal});
  if (!transaction || typeof transaction.commit !== 'function' || typeof transaction.rollback !== 'function')
    throw new Error('The existing installation store has no atomic commit and rollback hooks.');
  try {
    throwIfAborted(signal);
    const directory = transaction.directory;
    if (!path.isAbsolute(directory || '') || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length)
      throw new Error('Runtime staging must be a new empty owned directory.');
    if (!path.isAbsolute(transaction.destination || '') || fs.lstatSync(transaction.destination, {throwIfNoEntry: false}) ||
        within(fs.realpathSync(directory), path.resolve(transaction.destination)))
      throw new Error('An unused immutable installation destination outside staging is required.');
    const archive = path.join(directory, listed.name);
    const fetched = await (dependencies.download || Upstream.download)(listed, archive, {signal, onProgress: options.onProgress});
    throwIfAborted(signal);
    if (fs.lstatSync(archive).isSymbolicLink() || !fs.statSync(archive).isFile()) throw new Error('The downloaded archive is not an owned regular file.');
    const bytes = fs.statSync(archive).size;
    if (listed.bytes !== undefined && bytes !== listed.bytes) throw new Error('The runtime archive size differs from the selected asset.');
    const archiveSha256 = require('../modules/shared/runtime/pinned-native-manager').hashFile(archive);
    const headers = fetched?.headers || {}, verificationFiles = selected.verificationFiles || [];
    const before = source.verify.filter(rule => !['archive-sums', 'codesign'].includes(rule.type));
    const after = source.verify.filter(rule => ['archive-sums', 'codesign'].includes(rule.type));
    const verify = (rules, root) => verifySource({source: {...source, verify: rules}, asset, archiveSha256, root, verificationFiles, headers, signal}, dependencies);
    const preflight = await verify(before);
    const extracted = path.join(directory, 'payload'); fs.mkdirSync(extracted);
    let root;
    if (source.layout.type === 'app-bundle') {
      const result = await dependencies.extractSignedBundle(archive, extracted, signal);
      root = fs.realpathSync(result?.root || '');
      if (!within(fs.realpathSync(extracted), root)) throw new Error('The signed bundle is outside extraction staging.');
    } else {
      await (dependencies.extractArchive || require('../modules/shared/runtime/safe-archive').extractArchive)(archive, extracted, signal);
      root = selectRoot(extracted, source.layout, signal);
    }
    throwIfAborted(signal);
    const postflight = await verify(after, root), verification = {verified: true, archiveSha256,
      receipts: [...preflight.receipts, ...postflight.receipts]};
    const measured = measuredRecord({source, build, root, declaration, signal});
    const persisted = validateBuild({...measured, root: path.resolve(transaction.destination)});
    throwIfAborted(signal);
    const installed = await transaction.commit({root, build: persisted, verification, asset});
    return {installed, build: persisted, verification};
  } catch (error) {
    try { await transaction.rollback(error); }
    catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
}

// Core has already selected this exact build and obtained consent. The returned
// installation is an input to fresh inventory and plan recomputation, not admission.
async function installBuild({build, source, manager, context = {}, installOptions = {}} = {}, dependencies = {}) {
  validateSource(source); validateBuild(build);
  if (build.source !== source.id || build.kind !== source.kind) throw new Error('The selected build does not belong to this source.');
  if (build.installed !== false || build.available === false) throw new Error('An available uninstalled build is required.');
  if (manager?.sources?.length && !manager.sources.some(item => item.id === source.id)) throw new Error('The manager does not own the selected source.');
  const options = selectedOptions(build, context, installOptions);
  throwIfAborted(options.signal);
  const input = {build, source, manager, context, installOptions};
  const install = async () => {
    if (typeof dependencies.installExact !== 'function') {
      if (dependencies.prepareInstallation || dependencies.registerLocal) return genericInstallation(input, dependencies, options);
      throw new Error('Exact backend installation is not configured.');
    }
    const installed = await dependencies.installExact({...input, options});
    throwIfAborted(options.signal);
    if (!installed || installed.version !== options.version) throw new Error('The backend installation does not match the selected version.');
    return {installed};
  };
  return context.withRuntimeMutation ? context.withRuntimeMutation({managerId: manager?.id || source.manager?.id || source.id,
    sectionId: options.sectionId || source.manager?.sectionId || 'default', version: options.version}, install) : install();
}

module.exports = {installBuild};
