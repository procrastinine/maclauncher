const providers = Object.freeze({
  epic: options => require('./external-store-downloads').createExternalStoreDownloads(options),
  gog: options => require('./external-store-downloads').createExternalStoreDownloads(options),
  itch: options => require('./itch-store-downloads').createItchStoreDownloads(options),
  'google-play': options => require('../modules/android/store/aggregate').createAndroidStoreDownloads(options)
});
function createExternalStoreDownloads(options) {
  if (!options || !Object.hasOwn(providers, options.store)) throw new Error('Choose an external game store.');
  return providers[options.store](options);
}
module.exports = { createExternalStoreDownloads, storeIds: Object.freeze(Object.keys(providers)),
  downloadStoreIds: Object.freeze(['steam', ...Object.keys(providers), 'fdroid', 'izzy']) };
