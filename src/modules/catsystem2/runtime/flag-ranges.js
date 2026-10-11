const XML = require("../startup");
const PROFILE = "CatSystem2-flag-ranges-2.6.1.76";

/** Native local/global banks derived from authored startup configuration. */
function parseFlagRanges({ engineVersion, document, flagCount } = {}) {
  if (engineVersion !== "2.6.1.76" || !Number.isInteger(flagCount) || flagCount < 1 || flagCount > 65536)
    throw new Error("This CatSystem2 flag-range version or extent is unsupported.");
  const section = XML.child(XML.child(document, "GAME", false), "flag", false);
  if (!section) throw new Error("CatSystem2 flag ranges require authored startup settings.");
  const banks = ["local", "global"].map((name, bank) => Array.from({ length: 8 }, (_, index) => {
    const node = XML.child(section, name + index, false), fallback = index ? [-1, -1] : [bank ? 512 : 0, 512];
    const pair = ["start", "count"].map((field, fieldIndex) => {
      const value = node && XML.value(node, field, false); if (value == null) return fallback[fieldIndex];
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < -1 || Number(value) > flagCount)
        throw new Error("CatSystem2 flag range exceeds its authored extent.");
      return Number(value);
    });
    if (pair[0] >= 0 && pair[1] >= 0 && pair[0] > flagCount - pair[1]) throw new Error("CatSystem2 flag range exceeds its authored extent.");
    return Object.freeze({ start: pair[0], count: pair[1] });
  }));
  return Object.freeze({ profile: PROFILE, range: (bank, index) => {
    if (!Number.isInteger(bank) || bank < 0 || bank > 0xffffffff || !Number.isInteger(index) || index < 0 || index >= 8)
      throw new Error("CatSystem2 flag-range selector exceeds its range.");
    return banks[Number(bank !== 0)][index];
  } });
}
module.exports = { PROFILE, parseFlagRanges };
