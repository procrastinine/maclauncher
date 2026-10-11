const { Arch } = require('builder-util');
const Model = require('./distribution-model.cjs');

module.exports = async function beforePack(context, { environment = process.env, dependencies } = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Package each native launcher architecture explicitly.');
  const plan = Model.assertPublishable(Model.createPlan({ arch,
    maximumMacOS: environment.MACLAUNCHER_NATIVE_MAXIMUM_MACOS || '13.0', dependencies }));
  context.packager.config.extraResources = Model.resourceRules(plan, context.packager.config.extraResources);
};
