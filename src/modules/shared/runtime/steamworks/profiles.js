const Environment = require("./environment");
const Catalog = require("../included-package-metadata").resolve(require("./profiles.json"));
const Pins = require("../included-package-metadata").resolve(require("./versions.json"));
const Source = require("./source-identity");
const Contract = require("../package-contract.cjs");

const invalid = (code, message) => Object.assign(new Error(message), { code });

const retiredProfiles = new Map([
  ["luasteam-4.0.2-sdk1.63-ml1", "luasteam-4.0.2-sdk1.63-ml1-offline-abi0.5.0"],
  ["steamworks4j-1.9.0-ml1", "steamworks4j-1.9.0-ml1-offline-abi0.5.0"],
  ["steamworks4j-1.10.0-ml1", "steamworks4j-1.10.0-ml1-offline-abi0.5.0"],
  ["greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64", "greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64-offline-abi0.5.0"]
]);

/** Saved ABI identifiers retain the same consumer contract on the owned helper. */
function normalizeProfileSelection(selection, { profiles = Catalog } = {}) {
  const abiProfile = retiredProfiles.get(selection?.abiProfile);
  if (!abiProfile) return selection;
  const profile = profiles.find(profile => profile.id === abiProfile);
  if (!profile) return selection;
  return { ...selection, abiProfile,
    ...(selection.version === "goldberg-mac-1.0.0-ml1-universal" ? { version: profile.helperVersion } : {}) };
}

/** Exact consumer interfaces are bound to one native payload and source. */
function resolveProfile({ id, pin, architecture, requiredInterfaces = [], profiles = Catalog }) {
  if (id == null) return null;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) {
    throw invalid("STEAM_API_PROFILE_INVALID", "Invalid Steam API compatibility profile.");
  }
  id = normalizeProfileSelection({ abiProfile: id }, { profiles }).abiProfile;
  const matches = profiles.filter(profile => profile.id === id);
  if (matches.length !== 1) throw invalid("STEAM_API_PROFILE_UNKNOWN", "This Steam API compatibility profile is not available.");
  const profile = matches[0];
  if (profile.schemaVersion !== 1 || profile.helperVersion !== pin?.version ||
      !Source.sameSourceIdentity({ sourceKind: profile.helperSourceKind,
        sourceRevision: profile.helperSourceRevision, sourceSha256: profile.helperSourceSha256 }, pin) ||
      profile.helperLibrarySha256 !== pin?.librarySha256 ||
      !/^[a-f0-9]{64}$/.test(profile.helperLibrarySha256 || "") ||
      !profile.architectures?.includes(architecture)) {
    throw invalid("STEAM_API_PROFILE_CHANGED", "The selected Steam API profile does not match this helper version or CPU.");
  }
  const interfaces = profile.interfaces;
  if (!Array.isArray(interfaces) || interfaces.length < 1 || interfaces.length > 128 ||
      new Set(interfaces).size !== interfaces.length || interfaces.some(value => typeof value !== "string" || !Environment.INTERFACE.test(value)) ||
      interfaces.filter(value => /^SteamClient\d{3}$/.test(value)).length !== 1) {
    throw invalid("STEAM_API_PROFILE_CHANGED", "The selected Steam API profile has invalid interface versions.");
  }
  if (requiredInterfaces.some(value => !interfaces.includes(value))) {
    throw invalid("STEAM_API_INTERFACES_UNAVAILABLE", "This Steam API profile does not support the game's exact interfaces.");
  }
  return { ...profile, interfaces: [...interfaces], architectures: [...profile.architectures] };
}

/** Consumer profiles select their declared helper, independently of catalog order. */
function selectProfile({ id, version, architecture, requiredInterfaces, profiles = Catalog, catalog = Pins }) {
  const selection = normalizeProfileSelection({ abiProfile: id, version }, { profiles });
  const listed = profiles.find(profile => profile.id === selection.abiProfile);
  const pin = Contract.selectPackageRecord(catalog, { version: selection.version ?? listed?.helperVersion, arch: architecture });
  const profile = resolveProfile({ id: selection.abiProfile, pin, architecture, requiredInterfaces, profiles });
  return { profile, pin };
}

module.exports = { resolveProfile, selectProfile, normalizeProfileSelection };
