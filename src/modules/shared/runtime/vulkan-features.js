'use strict';
// Vulkan 1.0 device features that an installed Vulkan driver reports. The
// graphics payload's maclauncher-vulkan-features helper loads the driver
// library through its ICD entry point (vk_icdGetInstanceProcAddr), without a
// Vulkan loader, and prints the features of each device the driver lists.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = 'maclauncher-vulkan-features';
// The helper in the graphics payload, or null when this build has none. Its
// content identity is part of a driver's description key, so successful
// selected-driver measurements survive a graphics payload relocation.
function helper() {
  try {
    if (process.platform !== 'darwin') return null;
    const file = path.join(fs.realpathSync(require('../reshade').runtimeRoot()), HELPER), stat = fs.statSync(file);
    if (!stat.isFile() || !(stat.mode & 0o111)) return null;
    return { file, key: `${HELPER}:${require('./verified-identity').fileDigest(file).sha256}` };
  } catch { return null; }
}
// Query one declared ICD library or the selected native entry point. Other
// libraries in its package are dependencies, not alternative drivers.
function driverLibraries(files, { entryPoint } = {}) {
  const real = file => { try { return fs.realpathSync(file); } catch { return file; } };
  const named = [], selected = entryPoint && real(entryPoint);
  let selectedICD;
  for (const file of files.filter(file => file.format === 'json')) {
    try {
      const library = JSON.parse(fs.readFileSync(file.path, 'utf8')).ICD?.library_path;
      if (typeof library === 'string' && library) {
        const resolved = real(path.resolve(path.dirname(file.path), library));
        named.push(resolved);
        if (selected === real(file.path)) selectedICD = resolved;
      }
    } catch {}
  }
  const native = files.filter(file => file.format === 'macho');
  const libraries = [...new Set(named)], facts = library => native.find(file => (file.realPath || real(file.path)) === library);
  const library = selectedICD || (selected && libraries.includes(selected) ? selected : libraries.length === 1 ? libraries[0]
    : libraries.length ? null : selected && facts(selected) ? selected : native.length === 1 ? native[0].realPath || real(native[0].path) : null);
  return library && facts(library) ? [{ library, cpuSlices: facts(library).cpuSlices || [] }] : [];
}
// A feature is recorded present when any device reports it. Returns undefined
// when nothing could be measured, so the driver stays unmeasured.
function measure(files, { tool = module.exports.helper(), run = spawnSync, entryPoint } = {}) {
  if (!tool) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:DYLD_|RESHADE_|MTL_CAPTURE_|VK_|MVK_)/.test(key)));
  for (const { library, cpuSlices } of driverLibraries(files, { entryPoint })) {
    // An Intel-only driver is measured through Rosetta on Apple silicon.
    const intel = process.arch === 'arm64' && cpuSlices.length && !cpuSlices.includes('arm64') && cpuSlices.includes('x86_64');
    const [command, args] = intel ? ['/usr/bin/arch', ['-x86_64', tool.file, library]] : [tool.file, [library]];
    let result;
    try { result = run(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20, env }); }
    catch { return undefined; }
    if (result.status !== 0) continue;
    try {
      const devices = JSON.parse(result.stdout).devices;
      if (!Array.isArray(devices) || !devices.length) continue;
      const features = {};
      for (const device of devices) for (const [name, value] of Object.entries(device?.features || {}))
        if (typeof value === 'boolean') features[name] = Boolean(features[name] || value);
      if (Object.keys(features).length) return features;
    } catch {}
  }
  return undefined;
}
// Requirements come from a source declaration's vulkanFeatures rules:
// [{ from: "<first version>", features: [...] }].
function required(declaration, version) {
  const { compareRuntimeVersions } = require('./pinned-native-manager');
  const rules = Array.isArray(declaration?.vulkanFeatures) ? declaration.vulkanFeatures : [];
  return [...new Set(rules.filter(rule => version && (!rule.from || compareRuntimeVersions(String(version), String(rule.from)) <= 0))
    .flatMap(rule => rule.features || []))];
}
// A driver lacks a requirement only when its measurement records the feature absent.
const lacks = (driver, requirements = []) => Boolean(driver?.vulkanFeatures) && requirements.some(feature => driver.vulkanFeatures[feature] === false);

module.exports = { HELPER, helper, measure, required, lacks, driverLibraries };
