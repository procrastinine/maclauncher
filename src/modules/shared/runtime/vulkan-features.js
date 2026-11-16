'use strict';
// Vulkan 1.0 device features that an installed Vulkan driver reports. The
// graphics payload's maclauncher-vulkan-features helper loads the driver
// library through its ICD entry point (vk_icdGetInstanceProcAddr), without a
// Vulkan loader, and prints the features of each device the driver lists.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = 'maclauncher-vulkan-features';
let located;
// The helper in the graphics payload, or null when this build has none. Its
// identity is part of a driver's description key, so a driver described
// without the helper is measured once the helper is present.
function helper() {
  if (located !== undefined) return located;
  try {
    if (process.platform !== 'darwin') return (located = null);
    const file = path.join(fs.realpathSync(require('../reshade').runtimeRoot()), HELPER), stat = fs.statSync(file);
    located = stat.isFile() && stat.mode & 0o111 ? { file, key: `${HELPER}:${stat.size}:${stat.mtimeMs}` } : null;
  } catch { located = null; }
  return located;
}
// The library a driver description names in its ICD manifest comes first; a
// manifest-less driver is tried through its Mach-O libraries. A library that
// is not a driver, such as a bundled Vulkan loader, is refused by the helper.
function driverLibraries(files) {
  const named = [];
  for (const file of files.filter(file => file.format === 'json')) {
    try {
      const library = JSON.parse(fs.readFileSync(file.path, 'utf8')).ICD?.library_path;
      if (typeof library === 'string' && library) named.push(path.resolve(path.dirname(file.path), library));
    } catch {}
  }
  const native = files.filter(file => file.format === 'macho');
  const real = file => { try { return fs.realpathSync(file); } catch { return file; } };
  const ordered = [...named.map(real), ...native.map(file => file.realPath || real(file.path))];
  return [...new Set(ordered)].map(library => ({ library, cpuSlices: native.find(file => (file.realPath || real(file.path)) === library)?.cpuSlices || [] }));
}
// A feature is recorded present when any device reports it. Returns undefined
// when nothing could be measured, so the driver stays unmeasured.
function measure(files, { tool = module.exports.helper(), run = spawnSync } = {}) {
  if (!tool) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:DYLD_|RESHADE_|MTL_CAPTURE_|VK_|MVK_)/.test(key)));
  for (const { library, cpuSlices } of driverLibraries(files).slice(0, 4)) {
    // An Intel-only driver is measured through Rosetta on Apple silicon.
    const intel = process.arch === 'arm64' && cpuSlices.length && !cpuSlices.includes('arm64') && cpuSlices.includes('x86_64');
    const [command, args] = intel ? ['/usr/bin/arch', ['-x86_64', tool.file, library]] : [tool.file, [library]];
    const result = run(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20, env });
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
