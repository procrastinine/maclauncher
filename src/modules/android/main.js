const manifest = require("./manifest.json");
const Custom = require("./custom-main");
const Providers = require("./provider-main");
const Jadx = require("./tools/jadx-manager");
const Decompile = require("./tools/decompile");

function normalizeRuntimeId(id) {
  return id === "macapk" || id === "aim" ? id : "klepton";
}
function runtimeFor(entry, context) {
  return normalizeRuntimeId(context?.runtimeId || entry?.runtimeId || entry?.preferredRuntime);
}
function owner(entry, context) { return runtimeFor(entry, context) === "klepton" ? Custom : Providers; }
function withRuntime(entry, context = {}) { return { ...context, runtimeId: runtimeFor(entry, context) }; }
const providerOwners = new Map(["macapk", "aim"].map(runtimeId => [runtimeId, {
  runtimeId, supports: { ...manifest.supports, saveLocationOverride: false },
  ensureRuntime: (entry, context) => Providers.ensureRuntime(entry, withRuntime(entry, context)),
  prepareSaveLocation: (entry, context) => Providers.prepareSaveLocation(entry, withRuntime(entry, context)),
  resolveSaveLocations: (entry, context) => Providers.resolveSaveLocations(entry, withRuntime(entry, context))
}]));

module.exports = {
  ...Custom, manifest, normalizeRuntimeId,
  get runtimeManagers() { return [...Custom.runtimeManagers, ...Providers.runtimeManagers, Jadx]; },
  get distributionSupplementals() { return require("./distribution-included.json"); },
  getRuntimeProvider(runtimeId) { return providerOwners.get(runtimeId) || null; },
  async resolveGameIcon(entry, context) {
    try {
      const icon = await Custom.resolveGameIcon(entry, context);
      if (icon) return icon;
    } catch (error) {
      context?.signal?.throwIfAborted();
      context?.logger?.debug?.("[android] APK icon: " + error.message);
    }
    return Providers.resolveGameIcon(entry, context);
  },
  onImport(entry, context) { return owner(entry, context).onImport(entry, withRuntime(entry, context)); },
  ensureRuntime(entry, context) { return owner(entry, context).ensureRuntime(entry, withRuntime(entry, context)); },
  prepareSaveLocation(entry, context) { return owner(entry, context).prepareSaveLocation(entry, withRuntime(entry, context)); },
  resolveSaveLocations(entry, context) { return owner(entry, context).resolveSaveLocations(entry, withRuntime(entry, context)); },
  launchRuntime(runtimeId, entry, context) {
    return runtimeId === "klepton" ? Custom.launchRuntime(runtimeId, entry, context) : Providers.launchRuntime(runtimeId, entry, context);
  },
  actions: {
    ...Custom.actions,
    inspectGame: async (entry, _payload, context = {}) => {
      const metadata = (await require("./package-set").inspectInput(entry.gamePath, { inspection: true, signal: context.signal })).metadata;
      return { ...metadata, architectureLabel: metadata.architectures.join(", ") || "Java",
        activity: metadata.launchers[0]?.activity || "No enabled launcher activity" };
    },
    decompileApk: Decompile.decompileApk,
    revealDecompiled: Decompile.revealDecompiled,
    ...Object.fromEntries(["listGoogleAccounts", "importFiles"].map(action => [action,
      (entry, payload, context) => owner(entry, context).actions[action](entry, payload, withRuntime(entry, context))]))
  },
  settingsActions: {
    ...Custom.settingsActions,
    macapkGoogleAccounts: (payload, context) => require("./providers/macapk/google-accounts").state(context, { refresh: payload?.refresh === true }),
    signInMacapkGoogle: (_payload, context) => require("./providers/macapk/google-accounts").signIn(context),
    removeMacapkGoogleAccount: (payload, context) => require("./providers/macapk/google-accounts").remove(payload?.accountId, context)
  },
  settingsHostAccountActions: {
    googleAccounts: { manager: "google-play", action: "state", provider: "klepton" },
    signInGoogle: { manager: "google-play", action: "signIn", provider: "klepton" },
    removeGoogleAccount: { manager: "google-play", action: "remove", provider: "klepton" },
    macapkGoogleAccounts: { manager: "google-play", action: "state", provider: "macapk" },
    signInMacapkGoogle: { manager: "google-play", action: "signIn", provider: "macapk" },
    removeMacapkGoogleAccount: { manager: "google-play", action: "remove", provider: "macapk" }
  }
};
