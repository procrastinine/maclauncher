const { decodeStoredData } = require("./data-records");

const PROFILE = "CatSystem2-CSS-slots-2.6.1.76";
function slotName(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new Error("CatSystem2 save slot exceeds its range.");
  return "save" + String(value).padStart(4, "0") + ".dat";
}

/** Numbered CSS records; file operations remain confined to the save provider. */
function createSaveSlots({ engineVersion, store, signal } = {}) {
  if (engineVersion !== "2.6.1.76" || ![store?.read, store?.write, store?.remove].every(value => typeof value === "function"))
    throw new Error("This CatSystem2 save-slot version is unsupported.");
  async function exists(slot, minimum = -1, maximum = minimum) {
    signal?.throwIfAborted();
    const name = slotName(slot);
    if (![minimum, maximum].every(value => Number.isInteger(value) && value >= -1 && value <= 0x7fffffff) ||
        minimum === -1 && maximum !== -1 || minimum !== -1 && maximum < minimum)
      throw new Error("CatSystem2 save version range is invalid.");
    const bytes = await store.read(name);
    if (bytes === null) return 0;
    const record = await decodeStoredData(bytes); signal?.throwIfAborted();
    return minimum === -1 || record.version >= minimum && record.version <= maximum ? 1 : -1;
  }
  async function copy(source, destination) {
    signal?.throwIfAborted();
    const sourceName = slotName(source), destinationName = slotName(destination), bytes = await store.read(sourceName);
    if (bytes === null) return false;
    await decodeStoredData(bytes); signal?.throwIfAborted();
    if (sourceName === destinationName) return true;
    return store.write(destinationName, bytes);
  }
  async function remove(slot) { signal?.throwIfAborted(); return store.remove(slotName(slot)); }
  return { profile: PROFILE, exists, copy, remove };
}
module.exports = { PROFILE, slotName, createSaveSlots };
