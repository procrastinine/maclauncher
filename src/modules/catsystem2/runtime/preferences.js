const PROFILE = "cs2-2.6.1.76-preferences", SIZES = Object.freeze([5628, 72, 32, 12]);

/** Partial native layout: unestablished fields remain unreadable, never faked. */
function defaultRecords({ engineVersion, stored } = {}) {
  if (engineVersion !== "2.6.1.76") throw new Error("This CatSystem2 preference record version is unsupported.");
  if (stored != null) throw new Error("Stored CatSystem2 preference records are unsupported.");
  const records = SIZES.map(size => ({ bytes: Buffer.alloc(size), known: Buffer.alloc(size) }));
  function word(record, offset, value) { const item = records[record]; item.bytes.writeUInt32LE(value >>> 0, offset); item.known.fill(1, offset, offset + 4); }
  function nul(record, offset) { records[record].bytes[offset] = 0; records[record].known[offset] = 1; }
  // Legacy voice defaults from the runner's fresh preference initializer.
  // Leading volume fields depend on legacy XML; modern sound settings do not
  // read those fields. Unmodeled label/storage bytes retain an unknown mask.
  word(0, 16, 1);
  for (let index = 0; index < 48; index++) {
    const start = 20 + index * 116; word(0, start, 1); nul(0, start + 4); word(0, start + 36, 100); nul(0, start + 40); word(0, start + 80, 100);
  }
  for (let index = 0; index < 5; index++) { word(0, 5588 + index * 4, 100); word(0, 5608 + index * 4, 0); }
  // Message, effect and font defaults; XML-derived values are not substituted
  // for the two unestablished message-layout fields or an unknown spare field.
  for (const [offset, value] of [[0,4],[4,4],[8,0],[20,1],[24,0],[28,1],[32,0],[36,100],[40,0],[44,-1],[48,0],[56,0],[60,0],[64,0],[68,0]]) word(1,offset,value);
  for (const [index, value] of [0,0,1,1,1,5,0,0].entries()) word(2,index*4,value);
  for (const [index, value] of [-1,1,1].entries()) word(3,index*4,value);
  return { profile: PROFILE, records };
}
module.exports = { PROFILE, SIZES, defaultRecords };
