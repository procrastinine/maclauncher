// Backcompat: pre-restoration RPG Maker writable-input schema 1 mirrors.
// Runs only during the one-time profile migration, never import or Play.
// Remove after support for these old profile layouts ends.
module.exports = {legacyGameMirrors: require("../../shared/backcompat/writable-input").legacyGameMirrors};
