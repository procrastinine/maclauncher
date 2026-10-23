const Environment = require("./environment");
const Catalog = require("./profiles.json");
const Source = require("./source-identity");

const invalid = (code, message) => Object.assign(new Error(message), { code });

/** Exact consumer interfaces are bound to one native payload and source. */
function resolveProfile({ id, pin, architecture, requiredInterfaces = [], profiles = Catalog }) {
  if (id == null) return null;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) {
    throw invalid("STEAM_API_PROFILE_INVALID", "Invalid Steam API compatibility profile.");
  }
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

module.exports = { resolveProfile };
