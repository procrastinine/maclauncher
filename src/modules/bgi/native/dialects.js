const { engineVersionEvidence } = require("../inspect");

const PROFILES = Object.freeze([
  Object.freeze({ id: "legacy-v1", selection: "explicit-developer", addressBits: 24, localTag: "0x10", codeTag: "0x11" }),
  Object.freeze({ id: "ethornell-1.72", selection: "original-version-and-program-header", compatibilityVersions: Object.freeze(["1.72"]),
    addressBits: 26, localTag: "0x02", codeTag: "0x01", programHeaderBytes: 16, initialGlobalBytes: 65536, sys1: true })
]);

/** A header alone cannot certify a VM ABI. Original engine evidence is required. */
function selectVerifiedDialect(inspected) {
  const original = engineVersionEvidence(inspected?.originalRunner);
  const header = inspected?.boot;
  if (!original.version || original.version.split(".")[0] !== "1" || original.compatibility !== "1.72" ||
      header?.codeOffset !== 16 || !Number.isSafeInteger(header.codeBytes) || header.codeBytes < 1 ||
      header.headerWords?.[2] !== 0 || header.headerWords?.[3] !== 0)
    throw new Error("This BGI engine version and program header do not have a supported native VM dialect.");
  return PROFILES.find(profile => profile.id === "ethornell-1.72");
}

module.exports = { PROFILES, selectVerifiedDialect };
