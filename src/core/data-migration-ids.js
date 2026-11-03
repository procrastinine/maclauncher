// Completion keys of the one-time migrations under settings.dataMigrations.
// Current code checks a key's recorded completion before it requires the
// matching src/core/backcompat runner, so completed profiles load none.
// Each key is removed together with its runner.
module.exports = {
  ORIGINAL_GAME_MIRRORS_MIGRATION: "original-game-mirrors-v1",
  CURRENT_SETTINGS_MIGRATION: "current-settings-v1"
};
