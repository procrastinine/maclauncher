// Release tooling for small, module-declared native resources outside managers.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const B = require('../src/modules/shared/runtime/bundled-native');
const SHA = /^[a-f0-9]{64}$/;
const FLOOR = /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/;

function validatePublicMetadata(value) {
  const projected = require('./stage-native-runtimes.cjs').publicProvenance(value);
  if (!isDeepStrictEqual(value, projected)) throw new Error('Sealed native metadata contains private diagnostic fields. Restage the package before distribution.');
  return value;
}

function validateDeclaration(item) {
  const keys = ['id', 'version', 'arch', 'launcherArchitectures', 'minimumMacOS', 'sourceRelative', 'sourceSha256', 'sourceArtifact', 'directoryRelative', 'manifestRelative', 'manifestSha256', 'files', 'notices', 'redistribution'];
  if (!item || Object.keys(item).some(key => !keys.includes(key)) || !/^[a-z0-9-]+$/.test(item.id || '') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || '') || !['arm64', 'x64', 'universal'].includes(item.arch) ||
    !FLOOR.test(item.minimumMacOS || '') || !SHA.test(item.sourceSha256 || '') || !SHA.test(item.manifestSha256 || '') ||
    !Array.isArray(item.launcherArchitectures) || !item.launcherArchitectures.length || new Set(item.launcherArchitectures).size !== item.launcherArchitectures.length ||
    item.launcherArchitectures.some(arch => !['arm64', 'x64'].includes(arch)) ||
    item.directoryRelative !== `${item.id}/${item.version}/${item.arch}` || !Array.isArray(item.files) || !item.files.length || item.files.length > 1024 ||
      !Array.isArray(item.notices) || !item.notices.length ||
      item.redistribution !== undefined && !['bundle', 'local-only'].includes(item.redistribution)) throw new Error('Invalid supplemental native declaration.');
  const names = new Set(); let bytes = 0;
  for (const file of item.files) {
    if (!file || Object.keys(file).some(key => !['path', 'size', 'mode', 'sha256', 'architectures', 'executionArchitecture'].includes(key)) ||
      B.relativeFile(file.path) !== file.path || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > B.LIMITS.fileBytes ||
      ![0o644, 0o755].includes(file.mode) || !SHA.test(file.sha256 || '')) throw new Error('Invalid sealed supplemental native file.');
    if (file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || new Set(file.architectures).size !== file.architectures.length ||
      file.architectures.some(arch => !['arm64', 'x86_64'].includes(arch)))) throw new Error('Invalid supplemental native architectures.');
    // An explicitly Intel child can run under Rosetta in an ARM launcher. This
    // does not change the library's actual slices or make it loadable in an ARM
    // process; the module must select the Intel host and request Rosetta.
    if (Object.hasOwn(file, 'executionArchitecture')) {
      if (file.executionArchitecture !== 'x86_64' || !file.architectures?.includes('x86_64')) {
        throw new Error('Supplemental execution architecture requires a genuine Intel native file.');
      }
    } else if (file.architectures && item.launcherArchitectures.some(arch =>
      !file.architectures.includes(arch === 'x64' ? 'x86_64' : arch))) {
      throw new Error('Supplemental native architecture does not cover its launcher CPUs.');
    }
    names.add(file.path); bytes += file.size;
  }
  if (item.sourceArtifact !== undefined) {
    const source = require('./native-source-artifacts.cjs').validate({ managerId: item.id, version: item.version, ...item.sourceArtifact });
    if (source.managerId !== item.id || source.version !== item.version) throw new Error('Supplemental corresponding source must match its package identity.');
  }
  if (bytes > B.LIMITS.bytes || !item.files.some(file => file.architectures) ||
    (!item.sourceArtifact && item.sourceRelative === undefined) ||
    item.sourceRelative !== undefined && !item.files.some(file => file.path === item.sourceRelative && file.sha256 === item.sourceSha256) ||
    !item.files.some(file => file.path === item.manifestRelative && file.sha256 === item.manifestSha256)) throw new Error('Supplemental native source, manifest or dependency inventory is incomplete.');
  for (const notice of item.notices) {
    if (!notice || Object.keys(notice).some(key => !['name', 'license', 'path', 'sourceUrl'].includes(key)) ||
      typeof notice.name !== 'string' || !notice.name.trim() || typeof notice.license !== 'string' || !notice.license.trim() || !names.has(notice.path)) throw new Error('Supplemental native license notice is missing.');
    if (notice.sourceUrl && !/^https:\/\//.test(notice.sourceUrl)) throw new Error('Supplemental source links must use HTTPS.');
  }
  validatePublicMetadata(item);
  return item;
}
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
function verifySupplementals({ resourceRoot, arch, maximumMacOS, items, dependencies = {} }) {
  const selected = items || requirements({ arch, maximumMacOS }, dependencies);
  for (const item of selected) {
    validateDeclaration(item);
    if (!item.launcherArchitectures.includes(arch) || !B.versionAtLeast(maximumMacOS, item.minimumMacOS)) throw new Error('Supplemental native CPU or macOS floor differs from the requested release.');
    const directory = path.join(resourceRoot, item.directoryRelative);
    B.verifyPayload(directory, item);
    const manifest = JSON.parse(B.readRegular(path.join(directory, item.manifestRelative), B.LIMITS.manifestBytes).bytes);
    validatePublicMetadata(manifest);
    if (process.platform === 'darwin') {
      const inspect = dependencies.loadCommands || require('./stage-native-runtimes.cjs').loadCommands;
      const verify = dependencies.verifySignature || (file => execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 30000, stdio: 'pipe' }));
      let observed = '0.0';
      for (const file of item.files.filter(file => file.architectures)) {
        const full = path.join(directory, file.path), floor = inspect(full).minimumMacOS;
        if (B.versionAtLeast(floor, observed)) observed = floor;
        verify(full);
      }
      if (!B.versionAtLeast(observed, item.minimumMacOS) || !B.versionAtLeast(item.minimumMacOS, observed)) throw new Error('Supplemental native floor differs from its real load commands.');
    }
  }
  return selected;
}
module.exports = { validatePublicMetadata, validateDeclaration, declarations, requirements, validateInventory, verifySupplementals };
