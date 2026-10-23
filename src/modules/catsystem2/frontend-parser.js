const LIMITS = Object.freeze({ characters: 32 * 1024 * 1024, lines: 250000, objects: 4096, blocks: 4096 });
function tokens(line) {
  const result = []; let token = "", quote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quote = !quote; token += c; }
    else if (!quote && c === "/" && line[i + 1] === "/") break;
    else if (!quote && /[ \t\r\n\f\v]/.test(c)) { if (token) result.push(token); token = ""; }
    else token += c;
  }
  if (quote) throw new Error("Unterminated FES quoted token.");
  if (token) result.push(token); return result;
}
function parseFrontEnd(text) {
  if (typeof text !== "string" || text.length > LIMITS.characters) throw new Error("FES source exceeds its character limit.");
  const lines = text.split(/\r?\n/); if (lines.length > LIMITS.lines) throw new Error("FES source exceeds its line limit.");
  const objects = new Map(), groups = new Map(), blocks = new Map(), macros = new Map(), constants = new Map(), preloads = [], keyBlocks = [];
  let section = null, columns = [], active;
  const fail = (message, line) => { throw new Error(`FES ${message} at line ${line}.`); };
  let wordSection = false;
  for (let index = 0; index < lines.length; index++) {
    const words = tokens(lines[index]); if (!words.length) continue;
    if (words[0].startsWith("#")) { wordSection = words[0] === "#MACRO"; continue; }
    if (!wordSection) continue;
    if (words.length !== 2 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[0]) || constants.has(words[0]) || words[1].length > 1024) fail("word macro is unsupported or repeated", index + 1);
    constants.set(words[0], words[1]);
  }
  const expand = value => {
    let quoted = false;
    const result = value.replace(/"|[A-Za-z_][A-Za-z0-9_]*/g, word => { if (word === '"') { quoted = !quoted; return word; } return quoted ? word : constants.get(word) ?? word; });
    if (result.length > 8192) throw new Error("FES expanded line exceeds its length limit."); return result;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1, source = section === "MACRO" ? lines[index] : expand(lines[index]), words = tokens(source); if (!words.length) continue;
    if (words[0].startsWith("#")) {
      const header = words[0].slice(1);
      if (["DEFINE", "OBJECT", "PRELOAD", "SUBCOMMAND", "KEYBLOCK", "MACRO"].includes(header)) {
        section = header; columns = words.slice(1); active = null;
        if (header === "OBJECT" && (!columns.length || new Set(columns).size !== columns.length)) fail("object columns are invalid", line);
      } else {
        if (words.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(header)) fail("block header is unsupported", line);
        // The engine concatenates repeated named headers, including START.
        section = "BLOCK"; active = blocks.get(header) || { name: header, line, statements: [] }; blocks.set(header, active);
        if (blocks.size > LIMITS.blocks) fail("block count exceeds its limit", line);
      }
      continue;
    }
    if (section === "DEFINE") {
      if (words.length !== 2 || !/^[A-Z][A-Z0-9]*$/.test(words[0])) fail("object definition is unsupported", line);
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(words[1]);
      if (!match) fail("object name is invalid", line);
      const name = match[1], count = match[2] == null ? 1 : Number(match[2]);
      if (!count || count > LIMITS.objects || objects.size + count > LIMITS.objects || groups.has(name)) fail("object count or group is invalid", line);
      const members = [];
      for (let i = 0; i < count; i++) {
        const id = match[2] == null ? name : `${name}[${i}]`;
        if (objects.has(id)) fail("object is repeated", line);
        const object = { id, group: name, index: i, type: words[0], attributes: new Map(), line };
        objects.set(id, object); members.push(object);
      }
      groups.set(name, members);
    } else if (section === "OBJECT") {
      if (words.length !== columns.length + 1) fail("object row does not match its declared columns", line);
      const targets = objects.has(words[0]) ? [objects.get(words[0])] : groups.get(words[0]);
      if (!targets) fail("object row refers to an undefined object", line);
      for (const target of targets) for (let i = 0; i < columns.length; i++) target.attributes.set(columns[i], words[i + 1]);
    } else if (section === "PRELOAD") {
      if (words.length !== 1) fail("preload row is invalid", line); preloads.push(words[0]);
    } else if (section === "SUBCOMMAND") {
      const colon = words.indexOf(":");
      if (!["oneshot", "continue"].includes(words[0]) || colon < 3 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[1]) || macros.has(words[1])) fail("subcommand definition is unsupported", line);
      macros.set(words[1], { name: words[1], mode: words[0], implementation: words[2], parameters: words.slice(3, colon), arguments: words.slice(colon + 1), line });
    } else if (section === "MACRO") continue;
    else if (section === "KEYBLOCK") keyBlocks.push({ values: words, columns, line });
    else if (section === "BLOCK") active.statements.push({ source: source.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, ""), words, line });
    else fail("statement has no declared section", line);
  }
  if (!blocks.has("START")) throw new Error("FES requires an authored START block.");
  return { format: "FES", objects, groups, blocks, macros, constants, preloads, keyBlocks };
}
module.exports = { LIMITS, tokens, parseFrontEnd };
