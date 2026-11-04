const { Arch } = require('builder-util');
const Model = require('./distribution-model.cjs');
const Content = require('./runtime-content.cjs');

module.exports = async function beforePack(context, { environment = process.env, dependencies } = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Package each native launcher architecture explicitly.');
  const plan = Model.assertPublishable(Model.createPlan({ arch,
    maximumMacOS: environment.MACLAUNCHER_NATIVE_MAXIMUM_MACOS || '13.0', dependencies }));
  const projectDir=context.packager.info?.projectDir || require('node:path').resolve(__dirname,'..');
  const lockFile=require('node:path').join(projectDir,'build/runtime-packages.json');
  const packageLock=require('node:fs').existsSync(lockFile) ? require('./runtime-packages.cjs').readLock({repoRoot:projectDir,arch,dependencies}) : undefined;
  const filtered = Content.applyBuildPolicy(context.packager.config);
  context.packager.config.files = filtered.files;
  context.packager.config.extraResources = Model.resourceRules(plan, filtered.extraResources,{packages:packageLock?.packages});
  const packageConfig = { ...require('../package.json'), build: context.packager.config };
  context.packager.config.asarUnpack = [...new Set([...(context.packager.config.asarUnpack || []),
    ...require('./app-deduplication.cjs').unpackPatterns({ projectDir, packageConfig })])];
};
