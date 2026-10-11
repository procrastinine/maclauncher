const XML = require("../startup");
const PROFILE = "CatSystem2-startup-options-2.6.1.76";
const FIELDS = new Map([[999, { section: "GAME", name: "autoselect", fallback: 0 }]]);

/** Established native startup getters, including the runner's absent defaults. */
function parseStartupOptions({ engineVersion, document } = {}) {
  if (engineVersion !== "2.6.1.76" || document?.name !== "document" || !Array.isArray(document.children))
    throw new Error("This CatSystem2 native startup version is unsupported.");
  const values = new Map();
  for (const [id, field] of FIELDS) {
    const raw = XML.value(XML.child(document, field.section, false), field.name, false);
    const value = raw == null ? field.fallback : Number(raw);
    if (raw != null && !/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw new Error("CatSystem2 native startup option exceeds its range.");
    values.set(id, value);
  }
  return Object.freeze({ profile: PROFILE, get(id) {
    if (!values.has(id)) throw new Error("This CatSystem2 native startup option is unsupported."); return values.get(id);
  } });
}
module.exports = { PROFILE, parseStartupOptions };
