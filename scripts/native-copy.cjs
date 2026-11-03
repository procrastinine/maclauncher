// Preserve sealed native files before Electron Builder seals the outer app.
const fs = require('node:fs');
const path = require('node:path');
const B = require('../src/modules/shared/runtime/bundled-native');
const S = require('./native-supplementals.cjs');
const { distributionArchitectures } = require('./verify-native-runtimes.cjs');
const Model = require('./distribution-model.cjs');
const { preferredIncludedBuilds } = require('../src/modules/shared/runtime/included-helpers');

function restoreCopiedNativePayload({ sourceRoot, resourceRoot, architectures = [process.arch], requiredOnly = false, dependencies = {} } = {}) {
  if (!Array.isArray(architectures) || !architectures.length || architectures.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('Choose explicit native copy architectures.');
  const source = path.resolve(sourceRoot), destination = path.resolve(resourceRoot);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) throw new Error('Native source and copied app resources must be separate directories.');
  B.realDirectory(source);
  const catalog = (dependencies.managers || require('./stage-native-runtimes.cjs').managers)();
  const expected = new Map(), directories = new Set(['']);
  let maximumMacOS = '0.0';
  function add(name, record) {
    const relative = B.relativeFile(name);
    if (expected.has(relative)) throw new Error('Overlapping native copy inventories.');
    const original=path.join(source,relative);
    if(fs.existsSync(original)&&fs.lstatSync(original).isSymbolicLink())record={...record,aliasTarget:fs.readlinkSync(original)};
    expected.set(relative, record);
    for (let directory = path.posix.dirname(relative); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
  }
  const manifestFiles = requiredOnly
    ? [...new Set(architectures.flatMap(arch => Model.nativeRequirements({ arch, maximumMacOS: '99.0' }, dependencies))
      .map(item => `${item.managerId}/${item.version}/${item.arch}/manifest.json`))]
    : B.fileInventory(source).filter(file => file.endsWith('/manifest.json'));
  for (const file of manifestFiles) {
    const stored = B.readRegular(path.join(source, file), B.LIMITS.manifestBytes), manifest = JSON.parse(stored.bytes);
    const manager = catalog.get(manifest.managerId), pin = manager?.core?.catalog.find(item => item.version === manifest.version);
    if (!pin || !architectures.some(arch => distributionArchitectures(manager, arch).includes(manifest.arch))) throw new Error('Native copy contains an uncataloged version or unsupported artifact architecture.');
    B.validateManifest(manifest, { managerId: manager.id, version: pin.version, upstreamRevision: pin.upstreamRevision, arch: manifest.arch });
    S.validatePublicMetadata(manifest);
    const directory = path.posix.dirname(file);
    if (![`${manifest.managerId}/${manifest.version}/${manifest.arch}`, `${manifest.managerId}/${manifest.arch}`].includes(directory)) throw new Error('Native copy folder differs from its pinned identity.');
    B.verifyPayload(path.join(source, directory, 'files'), manifest);
    add(file, { size: stored.size, sha256: stored.sha256, mode: 0o644 });
    for (const item of manifest.files) add(`${directory}/files/${item.path}`, item);
    if (B.versionAtLeast(manifest.minimumMacOS, maximumMacOS)) maximumMacOS = manifest.minimumMacOS;
  }
  const supplementals = [...new Map(architectures.flatMap(arch => S.requirements({ arch }, dependencies)).map(item => [item.directoryRelative, item])).values()];
  for (const item of supplementals) {
    if (B.versionAtLeast(item.minimumMacOS, maximumMacOS)) maximumMacOS = item.minimumMacOS;
    for (const file of item.files) add(`${item.directoryRelative}/${file.path}`, file);
  }
  for (const arch of architectures) S.verifySupplementals({ resourceRoot: source, arch, maximumMacOS,
    items: preferredIncludedBuilds(supplementals, arch), dependencies });
  const lockFile=path.join(path.dirname(source),'runtime-packages.json');
  if(fs.existsSync(lockFile)){
    const Lock=require('./runtime-packages.cjs'),lock=JSON.parse(B.readRegular(lockFile,B.LIMITS.manifestBytes).bytes);
    const records=[...new Map(architectures.flatMap(arch=>Lock.selectArchitecture(lock,arch).packages).map(record=>[record.asset.sha256,record])).values()];
    const context=require('../src/modules/shared/runtime/included-package-dependencies').context(path.dirname(source),{lock:{...lock,packages:records}});
    for(const record of records){
      const selected=context.visit(record),logical=require('../src/modules/shared/runtime/package-contract.cjs').logicalFiles(selected.declaration,selected.resolveDependency);
      for(const file of logical){const name=selected.declaration.directoryRelative+'/'+file.path;if(!expected.has(name))add(name,file);}
      const name='.declarations/'+record.asset.sha256+'.json',stored=B.readRegular(path.join(source,name),B.LIMITS.manifestBytes);
      if(!expected.has(name))add(name,{size:stored.size,mode:stored.mode,sha256:stored.sha256});
    }
  }
  if (!expected.size) throw new Error('There are no sealed native files to copy.');
  function inspect(root, allowMissing) {
    const seen = new Set();
    function walk(relative) {
      const directory = path.join(root, relative); B.realDirectory(directory);
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory() && directories.has(name)) walk(name);
        else if ((item.isFile() || item.isSymbolicLink()) && expected.has(name)) {
          const sealed=expected.get(name),full=path.join(root,name);
          if(item.isSymbolicLink()&&(!sealed.aliasTarget||fs.readlinkSync(full)!==sealed.aliasTarget))throw new Error('Native copy alias differs from its sealed source.');
          const actual=B.readRegular(item.isSymbolicLink()?fs.realpathSync(full):full,sealed.size);
          if (actual.size !== sealed.size || actual.sha256 !== sealed.sha256 || !allowMissing && actual.mode !== sealed.mode) throw new Error('Native copy bytes or source permissions differ from their sealed inventory.');
          seen.add(name);
        } else throw new Error('Native copy contains a path outside its sealed inventory.');
      }
    }
    walk('');
    if (!allowMissing && seen.size !== expected.size) throw new Error('Sealed native source files are missing.');
  }
  if (!requiredOnly) inspect(source, false);
  B.realDirectory(destination, { create: true });
  // Review every existing copied path before restoring missing markers/modes.
  // Unknown extras and changed bytes fail; this never silently removes them.
  inspect(destination, true);
  let restoredFiles = 0, restoredModes = 0;
  for (const [relative, sealed] of expected) {
    const target = path.join(destination, relative);
    if (!fs.existsSync(target)) {
      const original = B.readRegular(fs.realpathSync(path.join(source, relative)), sealed.size);
      if (original.size !== sealed.size || original.sha256 !== sealed.sha256) throw new Error('Native source changed during copy restoration.');
      B.realDirectory(path.dirname(target), { create: true });
      if(sealed.aliasTarget)fs.symlinkSync(sealed.aliasTarget,target);
      else{fs.writeFileSync(target, original.bytes, { flag: 'wx', mode: sealed.mode });fs.chmodSync(target, sealed.mode);}
      restoredFiles++;
    } else if (!fs.lstatSync(target).isSymbolicLink() && (fs.lstatSync(target).mode & 0o777) !== sealed.mode) {
      fs.chmodSync(target, sealed.mode); restoredModes++;
    }
  }
  inspect(destination, false);
  return { files: expected.size, restoredFiles, restoredModes };
}

module.exports = { restoreCopiedNativePayload };
