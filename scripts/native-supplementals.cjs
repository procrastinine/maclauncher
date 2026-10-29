// Release tooling for small, module-declared native resources outside managers.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const B = require('../src/modules/shared/runtime/bundled-native');
const { validatePublicMetadata, validateDeclaration, checksum } = require("../src/modules/shared/runtime/package-contract.cjs");

function declarations(dependencies) {
  let items;
  if (dependencies?.supplementals) items = dependencies.supplementals();
  else {
    const modules = require('../src/modules/registry');
    items = [];
    const loaded = modules.listModules(), moduleRoot = path.resolve(__dirname, '../src/modules');
    for (const directory of fs.readdirSync(moduleRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'shared')) {
      const manifestPath = path.join(moduleRoot, directory.name, 'manifest.json'), mainPath = path.join(moduleRoot, directory.name, 'main.js');
      if (!fs.existsSync(manifestPath) || !fs.existsSync(mainPath)) continue;
      const manifest = JSON.parse(B.readRegular(manifestPath, B.LIMITS.manifestBytes).bytes);
      if (!loaded.some(info => info.id === manifest.id) || !modules.getModule(manifest.id)) throw new Error(`Backend module failed to load for release verification: ${directory.name}`);
    }
    for (const info of loaded) {
      const mod = modules.getModule(info.id), reference = info.distributionSupplementals;
      if (!reference) {
        if (mod?.distributionSupplementals) throw new Error('Supplemental resources need a module manifest declaration.');
        continue;
      }
      if (!reference || Object.keys(reference).length !== 1 || typeof reference.path !== 'string' || !reference.path.endsWith('.json')) throw new Error('Supplemental resource metadata must reference a module-owned JSON file.');
      const relative = B.relativeFile(reference.path);
      const stored = JSON.parse(B.readRegular(path.join(mod.__moduleDir, relative), B.LIMITS.manifestBytes).bytes);
      if (!Array.isArray(stored) || !isDeepStrictEqual(stored, mod.distributionSupplementals)) throw new Error('Module supplemental metadata differs from its pure export.');
      items.push(...stored);
    }
    for (const submodule of modules.listSharedSubmodules()) {
      const declaration = path.join(submodule.dir, 'distribution-supplementals.json');
      if (!fs.existsSync(declaration)) continue;
      const stored = JSON.parse(B.readRegular(declaration, B.LIMITS.manifestBytes).bytes);
      if (!Array.isArray(stored)) throw new Error('Shared supplemental resources need a pure JSON declaration.');
      items.push(...stored);
    }
  }
  if (!Array.isArray(items) || items.length > 128) throw new Error('Invalid supplemental resource catalog.');
  const seen = new Set();
  for (const item of items) {
    validateDeclaration(item);
    if (seen.has(item.directoryRelative)) throw new Error('Duplicate supplemental native declaration.');
    seen.add(item.directoryRelative);
  }
  return items;
}
function requirements(config, dependencies) {
  return declarations(dependencies).filter(item => item.launcherArchitectures.includes(config.arch))
    .sort((a, b) => a.directoryRelative.localeCompare(b.directoryRelative));
}
function validateInventory(items, config, dependencies) {
  const expected = requirements(config, dependencies);
  if (!Array.isArray(items) || !isDeepStrictEqual(items, expected)) throw new Error('Payload supplemental resources differ from the complete module declarations.');
  if (items.some(item => !B.versionAtLeast(config.maximumMacOS, item.minimumMacOS))) throw new Error('Supplemental native payload exceeds the explicitly selected macOS floor.');
  return items;
}
function nativeHostDependencies(dependencies) {
  const rows = dependencies?.nativeHostDependencies ? dependencies.nativeHostDependencies() :
    require('../src/modules/registry').listModules().flatMap(info =>
      require('../src/modules/registry').getModule(info.id)?.nativeHostDependencies?.() || []);
  if (!Array.isArray(rows) || rows.length > 128) throw new Error('Invalid native host dependency declarations.');
  for (const row of rows) {
    if (!row || !/^[a-z0-9-]+$/.test(row.id || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.version || '') ||
        !checksum(row.sha256) || B.relativeFile(row.file) !== row.file ||
        typeof row.dependency !== 'string' || !row.dependency.startsWith('@loader_path/') ||
        B.relativeFile(row.dependency.slice(13)) !== row.dependency.slice(13) ||
        !/^[a-z0-9-]+$/.test(row.provider?.id || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.provider?.version || '') ||
        B.relativeFile(row.provider?.file) !== row.provider.file || !Array.isArray(row.installNames) ||
        row.installNames.some(value => typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)))
      throw new Error('Invalid native host dependency declaration.');
  }
  return rows;
}
function verifySupplementals({ resourceRoot, arch, maximumMacOS, items, dependencies = {} }) {
  const selected = items || requirements({ arch, maximumMacOS }, dependencies);
  const hostDependencies = nativeHostDependencies(dependencies);
  for (const item of selected) {
    validateDeclaration(item);
    if (!item.launcherArchitectures.includes(arch) || !B.versionAtLeast(maximumMacOS, item.minimumMacOS)) throw new Error('Supplemental native CPU or macOS floor differs from the requested release.');
    const directory = path.join(resourceRoot, item.directoryRelative);
    B.verifyPayload(directory, item);
    const manifest = JSON.parse(B.readRegular(path.join(directory, item.manifestRelative), B.LIMITS.manifestBytes).bytes);
    validatePublicMetadata(manifest);
    if (process.platform === 'darwin') {
      const native = require('./native-binary-tools.cjs');
      const inspect = dependencies.loadCommands || native.loadCommands;
      const links = dependencies.links || native.links, libraryIds = dependencies.libraryIds || native.libraryIds;
      const resolveLink = dependencies.resolveLink || native.resolveLink;
      const verify = dependencies.verifySignature || (file => execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 30000, stdio: 'pipe' }));
      const files = new Map(item.files.filter(file => file.architectures).map(file => [fs.realpathSync(path.join(directory, file.path)), file]));
      const commands = new Map(), linked = new Map();
      function closureFloor(full, architecture, seen = new Set()) {
        const key = JSON.stringify([full, architecture]);
        if (seen.has(key)) return '0.0';
        seen.add(key);
        if (!commands.has(key)) commands.set(key, inspect(full, architecture));
        const info = commands.get(key);
        let floor = info.minimumMacOS;
        if (!linked.has(key)) {
          const ids = libraryIds(full, architecture);
          const file = files.get(full);
          linked.set(key, links(full, architecture).filter(link => !ids.includes(link)).map(link => {
            const host = hostDependencies.find(row => row.id === item.id && row.version === item.version &&
              row.file === file.path && row.sha256 === file.sha256 && row.dependency === link);
            if (host) {
              const provider = selected.find(row => row.id === host.provider.id && row.version === host.provider.version);
              const library = provider?.files.find(row => row.path === host.provider.file);
              if (!library?.architectures?.includes(architecture) || library.optionalLoad)
                throw new Error('The native plugin host dependency is missing from its declared CPU closure.');
              // The provider is verified separately against its complete
              // sealed inventory, CPU slices, load closure, floor and signature.
              return null;
            }
            return resolveLink(link, full, full, info.rpaths || [], architecture);
          }).filter(Boolean));
        }
        for (const dependency of linked.get(key)) {
          if (!files.get(dependency)?.architectures.includes(architecture)) throw new Error('Supplemental native dependency is outside its declared CPU closure.');
          const required = closureFloor(dependency, architecture, seen);
          if (B.versionAtLeast(required, floor)) floor = required;
        }
        return floor;
      }
      let observed = '0.0';
      for (const file of item.files.filter(file => file.architectures)) {
        const full = fs.realpathSync(path.join(directory, file.path));
        for (const architecture of file.architectures) {
          const floor = closureFloor(full, architecture);
          if (file.optionalLoad) {
            // Functional availability checks may require a newer OS than the
            // linked code's deployment target. The complete load closure must
            // fit within that requirement, rather than equal it.
            if (!B.versionAtLeast(file.optionalLoad.minimumMacOS, floor)) throw new Error('Optional native provider exceeds its declared macOS requirement.');
          } else if (B.versionAtLeast(floor, observed)) observed = floor;
        }
        verify(full);
      }
      if (item.files.some(file => file.architectures && !file.optionalLoad) &&
          (!B.versionAtLeast(observed, item.minimumMacOS) || !B.versionAtLeast(item.minimumMacOS, observed)))
        throw new Error('Supplemental native floor differs from its real load commands.');
    }
  }
  return selected;
}
module.exports = { validatePublicMetadata, validateDeclaration, declarations, requirements, validateInventory, nativeHostDependencies, verifySupplementals };
