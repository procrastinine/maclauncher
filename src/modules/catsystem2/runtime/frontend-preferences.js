const { PROFILE } = require("./preferences"), { parseLanguages } = require("../startup");
const FIELDS = Object.freeze({ stillread: { record: 1, offset: 20, maximum: 1 }, contauto: { record: 1, offset: 24, maximum: 1 },
  waitpcm: { record: 1, offset: 28, maximum: 1 }, messpd: { record: 1, offset: 0, maximum: 100 }, autospd: { record: 1, offset: 4, maximum: 100 },
  wndcolor: { record: 2, offset: 0, maximum: 0x64ffffff }, dragwnd: { record: 2, offset: 4, maximum: 1 }, wndframe: { record: 2, offset: 8, maximum: 1 } });

/** Exact established preference fields; language changes retain authored IDs. */
function createFrontEndPreferences({ engineVersion, records, document, userLanguageCode, onLanguageChange } = {}) {
  if (engineVersion !== "2.6.1.76" || records?.profile !== PROFILE) throw new Error("This CatSystem2 front-end preference version is unsupported.");
  const languages = parseLanguages(document), values = new Map();
  if (languages) {
    // The native fresh initializer writes 0,0,-1. Startup language loading
    // selects a matching user language for the first two fields, when present.
    if (userLanguageCode != null && (!Number.isInteger(userLanguageCode) || userLanguageCode < 1 || userLanguageCode > 65535)) throw new Error("The host language code is invalid.");
    const initial = userLanguageCode == null ? 0 : languages.items.find(item => item.code === userLanguageCode)?.index ?? 0;
    values.set("lang_ui", initial); values.set("lang_text_main", initial); values.set("lang_text_sub", -1);
  }
  function requireArguments(args) { if (!Array.isArray(args) || args.length) throw new Error("These FES preference arguments are unsupported."); }
  function readField(name) {
    const field = FIELDS[name], item = field && records.records?.[field.record];
    if (!item || !Buffer.isBuffer(item.bytes) || !Buffer.isBuffer(item.known) || field.offset > item.bytes.length - 4 ||
        item.known.subarray(field.offset, field.offset + 4).some(value => value !== 1)) throw new Error("This FES preference field is unsupported.");
    return { field, item };
  }
  function get(name, args = []) {
    requireArguments(args); if (values.has(name)) return values.get(name);
    const { field, item } = readField(name); return item.bytes.readInt32LE(field.offset);
  }
  async function set(name, value, args = []) {
    requireArguments(args); if (!Number.isInteger(value)) throw new Error("FES preference value exceeds its range.");
    if (values.has(name)) {
      if (name === "lang_text_sub" && value === -1 || value >= 0 && value < languages.items.length) {
        const changed = values.get(name) !== value; values.set(name, value);
        if (changed) await onLanguageChange?.({ field: name, index: value, prefix: value < 0 ? null : languages.items[value].prefix });
      } else throw new Error("FES language selection exceeds its authored table.");
    } else {
      const { field, item } = readField(name); if (value < 0 || value > field.maximum) throw new Error("FES preference value exceeds its range.");
      item.bytes.writeInt32LE(value, field.offset);
    }
  }
  return { get, set, values, languages, get language() { return languages?.items[values.get("lang_ui")]?.prefix ?? null; } };
}
module.exports = { FIELDS, createFrontEndPreferences };
