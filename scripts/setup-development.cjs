#!/usr/bin/env node
// Explicit installation prepares the same pinned inputs used by app builds.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// These inputs target the selected launcher CPU; the default is this Node process, including under Rosetta.
async function prepareDevelopmentInputs({ repoRoot = ROOT, arch = process.arch, platform = process.platform,
  installElectron = () => require('./ci-macos.cjs').prepareElectron({ repoRoot }),
  readLock = require('./runtime-packages.cjs').readLock,
  preparePython = require('./ci-macos.cjs').preparePython,
  prepareSevenZip = require('./published-inputs.cjs').prepareSevenZip,
  prepareDeclaredPublishers = require('./published-inputs.cjs').prepareDeclaredPublishers,
  prepareCp932 = require('../src/modules/catsystem2/runtime/stage-cp932.cjs').prepare,
  buildActivation = require('./build-launch-activation.cjs').build,
  buildRosettaLibraryLoader = require('../src/modules/shared/runtime/native/rosetta-library-load-build.mjs').buildRosettaLibraryLoader,
  fetchPackages = require('./runtime-packages.cjs').fetchPackages } = {}) {
  await installElectron();
  const cp932 = await prepareCp932({ repoRoot });
  if (platform !== 'darwin') return { electron: true, nativePackages: 0, platform, cp932 };
  buildActivation({ repoRoot, arch });
  buildRosettaLibraryLoader({ output: path.join(repoRoot, 'src/resources/rosetta-library-load-x64') });
  const lock = readLock({ repoRoot, arch });
  const python = await preparePython({ repoRoot, arch });
  const sevenZip = await prepareSevenZip({ repoRoot });
  const publishers = await prepareDeclaredPublishers({ repoRoot });
  const result = await fetchPackages({ repoRoot, lock });
  return { electron: true, arch, nativePackages: result.packages, ...python, sevenZip, publishers, cp932 };
}

async function main(args = process.argv.slice(2), { env = process.env } = {}) {
  if (args.length && (args.length !== 2 || args[0] !== '--arch' || !['arm64', 'x64'].includes(args[1])))
    throw new Error('Usage: node scripts/setup-development.cjs [--arch arm64|x64]');
  if (env.CI && env.npm_lifecycle_event === 'postinstall')
    return { skipped: true, reason: 'CI configure and fetch prepare the selected app inputs.' };
  return prepareDevelopmentInputs({ arch: args[1] || process.arch });
}

module.exports = { prepareDevelopmentInputs, main };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
