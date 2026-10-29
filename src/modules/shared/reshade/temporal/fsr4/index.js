const fs = require('node:fs'), path = require('node:path'),
      os = require('node:os');
const SOURCE = require('./source.json');
function resolve(root, {platform = process.platform, macOSVersion} = {}) {
  if (platform !== 'darwin' || typeof root !== 'string' || !root)
    return null;
  const darwin = Number(os.release().split('.')[0]);
  const major = macOSVersion === undefined
                    ? (darwin >= 25   ? darwin + 1
                       : darwin >= 20 ? darwin - 9
                                      : 10)
                    : Number(String(macOSVersion).split('.')[0]);
  if (!Number.isFinite(major) ||
      major < Number(SOURCE.minimumMacOS.split('.')[0]))
    return null;
  try {
    const directory = fs.realpathSync(path.join(root, 'temporal/fsr4')),
          metadata = JSON.parse(
              fs.readFileSync(path.join(directory, 'provider.json'), 'utf8'));
    if (metadata.providerABI !== 1 || metadata.complete !== true ||
        metadata.library !== 'libmaclauncher-fsr4.dylib' ||
        metadata.model !== SOURCE.model)
      return null;
    const legacy =
        SOURCE.legacyPayloads.find(value => value.commit === metadata.commit &&
                                            value.model === metadata.model);
    if (metadata.commit !== SOURCE.commit && !legacy)
      return null;
    let profiles;
    if (legacy) {
      if (major < Number(legacy.minimumMacOS.split('.')[0]) ||
          metadata.profile !== 'exact-fast')
        return null;
      profiles = [ 'exact-fast' ];
    } else {
      if (metadata.profilesAPI !== 1 || metadata.resourcePreparation !== 1 ||
          !Array.isArray(metadata.supportedProfiles) ||
          metadata.supportedProfiles.length !==
              SOURCE.supportedProfiles.length ||
          metadata.supportedProfiles.some(
              (name, index) => name !== SOURCE.supportedProfiles[index]) ||
          JSON.stringify(metadata.profiles) !== JSON.stringify(SOURCE.profiles))
        return null;
      profiles = [...metadata.supportedProfiles ];
      if (metadata.lite2?.sha256 !== SOURCE.lite2.sha256 ||
          metadata.lite2?.commit !== SOURCE.lite2.commit ||
          !fs.statSync(
                 path.join(directory, 'third_party/fsr411/LICENSE.Lite2.txt'))
               .isFile())
        return null;
    }
    const library = path.join(directory, metadata.library),
          build = path.join(directory, 'build');
    if (!fs.statSync(library).isFile() || !fs.statSync(build).isDirectory() ||
        !fs.statSync(
               path.join(directory, 'third_party/fsr411/initializers.bin'))
             .isFile())
      return null;
    return {
      directory,
      library,
      build,
      version : metadata.model,
      source : metadata.commit,
      minimumMacOS : legacy ? legacy.minimumMacOS : SOURCE.minimumMacOS,
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
    FSR4_BUILD_DIR : installed.build
  };
}
module.exports = {
  resolve,
  prepare
};
