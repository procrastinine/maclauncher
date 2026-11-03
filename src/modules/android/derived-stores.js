const images = require("./providers/aim/image-storage");

module.exports = [{
  // Finish an interrupted explicit game removal, never select live service data.
  id: "android-service-data-trash",
  directories: ({ userDataDir }) => [require("node:path").join(userDataDir, "android/apps")],
  match: require("../../core/storage-maintenance").TRASH
}, {
  id: "android-retired-aim-image-trees",
  directories: ({ userDataDir }) => images.imageDirectories(userDataDir),
  match: images.RETIRED,
  minAgeMs: 60 * 1000
}, {
  id: "android-superseded-microg",
  directories: ({ userDataDir }) => [require("node:path").join(userDataDir, "android/google/packages")],
  match: /^\d+(?:\.\d+)+$/,
  keep: (directory, context) => require("./google/package-retention").keepReleases(directory, context)
}];
