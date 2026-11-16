const fs = require('node:fs'), path = require('node:path');
const Host = require('../../../runtime/host-capabilities');
const Requirements = require('../../../runtime/feature-requirements');
const SOURCE = require('./source.json');
function inspect(root) {
  if (typeof root !== 'string' || !root) return null;
  try {
    const directory = fs.realpathSync(path.join(root, 'temporal/fsr4')),
          metadata = JSON.parse(
              fs.readFileSync(path.join(directory, 'provider.json'), 'utf8'));
    if (metadata.providerABI !== 1 || metadata.complete !== true ||
        metadata.library !== 'libmaclauncher-fsr4.dylib' ||
        metadata.model !== SOURCE.model)
      return null;
    const legacy =
        metadata.profilesAPI === undefined &&
        SOURCE.legacyPayloads.find(value => value.model === metadata.model);
    let profiles;
    if (legacy) {
      if (metadata.profile !== 'exact-fast')
        return null;
      profiles = [ 'exact-fast' ];
    } else {
      const contracts=[SOURCE.profiles,SOURCE.legacyProfileContracts];
      if (metadata.profilesAPI !== 1 || metadata.resourcePreparation !== 1 ||
          !contracts.some(rows=>JSON.stringify(metadata.supportedProfiles)===JSON.stringify(rows.map(p=>p.id)) &&
            JSON.stringify(metadata.profiles)===JSON.stringify(rows))) return null;
      profiles = [...metadata.supportedProfiles ];
    }
    const library = path.join(directory, metadata.library),
          build = path.join(directory, 'build');
    if (!fs.statSync(library).isFile() || !fs.statSync(build).isDirectory() ||
        !fs.statSync(
               path.join(directory, 'third_party/fsr411/initializers.bin'))
             .isFile())
      return null;
    const requiredFloor = legacy ? legacy.minimumMacOS : Requirements.FSR4.minimumMacOS;
    const minimumMacOS = metadata.minimumMacOS && Requirements.versionAtLeast(metadata.minimumMacOS, requiredFloor)
        ? metadata.minimumMacOS : requiredFloor;
    return {
      directory,
      library,
      build,
      version : metadata.model,
      source : metadata.commit,
      minimumMacOS,
      profiles,
      supportedProfiles : profiles,
      profileContracts :
          legacy ? SOURCE.profiles.filter(p => p.id === 'exact-fast')
                 : metadata.profiles
    };
  } catch {
    return null;
  }
}
function resolve(root, {platform = process.platform, macOSVersion, hardwareArch} = {}) {
  const installed = inspect(root);
  if (!installed) return null;
  const host = Host.getHostCapabilities();
  const actual = { ...host, platform,
    macOSVersion: macOSVersion === undefined ? host.macOSVersion : macOSVersion,
    hardwareArch: hardwareArch === undefined ? host.hardwareArch : hardwareArch };
  return Requirements.requirementSupport({ ...Requirements.FSR4, minimumMacOS: installed.minimumMacOS }, actual).supported === false
    ? null : installed;
}
function profileOptions(installed, userDataDir) {
  const labels={'exact-fast':'Exact Fast (4.1.1)',lite:'Lite (4.1.1)',lite2:'Lite 2 (4.1.1)',
    'int8-lite':'Lite (4.1.2)','lossy2-412':'Lossy (4.1.2)','int8-lite-lossy':'Lite Lossy (4.1.2)'};
  return SOURCE.profiles.map(profile=>{
    const supported=installed?.profiles?.includes(profile.id)===true;
    const data=profile.userData?require('./models').read(userDataDir):null;
    const ready=supported&&(!profile.userData||data?.profiles.includes(profile.id));
    return {id:profile.id,label:labels[profile.id],model:profile.model,available:ready,
      reason:!supported?'The installed FSR 4 provider does not support this profile.':!ready?'Download or import the FSR 4.1.2 model data.':null,
      ...(profile.userData?{delivery:{...require('./models').descriptor,...(profile.id==='int8-lite-lossy'?{downloadBytes:require('./model.json').archiveBytes+require('./model.json').lossy.archiveBytes}:{}),requiresDownload:!data?.profiles.includes(profile.id),canImport:true}}:{})};
  });
}
function prepare(root, options = {}) {
  const installed = resolve(root, options);
  if (!installed)
    return {};
  const profile = options.fsr4Profile || 'exact-fast';
  if (!installed.profiles.includes(profile))
    throw Error('The selected FSR4 provider does not contain the ' + profile +
                ' model profile.');
  return {
    RESHADE_FSR4_LIBRARY : installed.library,
    FSR4_ROOT : installed.directory,
    FSR4_BUILD_DIR : installed.build,
    ...(options.modelEnvironment || {})
  };
}
module.exports = {
  inspect,
  resolve,
  prepare,
  profileOptions
};
