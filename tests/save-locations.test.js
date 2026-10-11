const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { hydrateGameSaveLocations, selectKnownSaveLocation } = require("../src/core/save-locations");

const primary = path.resolve("/path/to/Library/Engine/configured-id");
const mirror = path.resolve("/Games/Example/game/saves");
const registry = { getModule: () => ({ resolveSaveLocations(entry, context) {
  assert.equal(context.userDataDir, "/launcher");
  entry.moduleData.locationEvidence = "archive!/options";
  return { primaryDirectory: primary, directories: [{ directory: primary, role: "primary" }, { directory: mirror, role: "mirror" }, { directory: primary, role: "primary" }] };
} }) };

test("engine save-location hydration refreshes stale defaults and preserves explicit overrides", () => {
  const entry = { moduleId: "example", defaultSaveDir: "/stale/title-guess", saveDirOverride: "/custom", moduleData: { preserved: true } };
  const next = hydrateGameSaveLocations(entry, registry, { userDataDir: "/launcher" });
  assert.equal(next.defaultSaveDir, primary);
  assert.equal(next.saveDirOverride, "/custom");
  assert.equal(next.moduleData.preserved, true);
  assert.equal(next.moduleData.locationEvidence, "archive!/options");
  assert.equal(next.saveLocations.length, 2);
  assert.deepEqual(entry.moduleData, { preserved: true });
});

test("UI selection accepts only declared engine save roots and clears overrides for the primary", () => {
  const entry = { moduleId: "example" };
  assert.equal(selectKnownSaveLocation(entry, mirror, registry, { userDataDir: "/launcher" }).saveDirOverride, mirror);
  assert.equal(selectKnownSaveLocation(entry, primary, registry, { userDataDir: "/launcher" }).saveDirOverride, null);
  assert.throws(() => selectKnownSaveLocation(entry, "/unrelated", registry, { userDataDir: "/launcher" }), /engine-detected/);
  assert.throws(() => selectKnownSaveLocation(entry, "relative", registry, { userDataDir: "/launcher" }), /engine-detected/);
});

test("engines without a save-location hook keep existing behavior", () => {
  const entry = { moduleId: "other", defaultSaveDir: "/existing" };
  assert.equal(hydrateGameSaveLocations(entry, { getModule: () => ({}) }), entry);
});

test("invalid save-location hook results cannot introduce relative paths", () => {
  for (const result of [{ primaryDirectory: "relative", directories: [] }, { primaryDirectory: primary, directories: [{ directory: "../elsewhere" }] }]) {
    assert.throws(() => hydrateGameSaveLocations({ moduleId: "example" }, { getModule: () => ({ resolveSaveLocations: () => result }) }), /absolute paths/);
  }
});
