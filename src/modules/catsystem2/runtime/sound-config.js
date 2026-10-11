const { parseXml, child, value } = require("../startup");
const LIMITS = Object.freeze({ parts: 1024, depth: 16 });
const NUMERIC = Object.freeze({ id: [0, 65535], group: [0, 65535], mastervol: [0, 100], volume: [0, 100], play: [0, 1], mute: [0, 1], sysplay: [-1, 1], voicevol: [-1, 100], skipvol: [0, 100], sameid: [-1, 65535] });
const TEXT = new Set(["name", "type", "head", "int"]);
const PROFILE = "CatSystem2-sound-parts-2.6.1.76";

function number(node, name, minimum, maximum, fallback) {
  const source = value(node, name, false); if (source == null) return fallback;
  if (!/^-?\d+$/.test(source)) throw new Error("Unsupported CatSystem2 sound configuration integer.");
  const result = Number(source); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error("CatSystem2 sound configuration value exceeds its range."); return result;
}
function parseSoundConfig(bytes, { engineVersion } = {}) {
  if (engineVersion != null && engineVersion !== "2.6.1.76") throw new Error("This CatSystem2 sound configuration version is unsupported.");
  const profile = engineVersion === "2.6.1.76" ? PROFILE : null;
  const document = parseXml(bytes), groups = new Map(), all = [], tags = new Map();
  for (const node of child(document, "SOUNDGROUP").children) {
    if (!/^group\d{2}$/.test(node.name)) throw new Error("Unsupported CatSystem2 sound-group definition.");
    const id = number(node, "id", 0, 65535), minimum = number(node, "min", 0, 255), maximum = number(node, "max", 0, 255), label = value(node, "label");
    if (id == null || minimum == null || maximum == null || minimum > maximum || groups.has(id) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) throw new Error("Invalid or repeated CatSystem2 sound group.");
    groups.set(id, { id, minimum, maximum, label });
  }
  const masterNode = child(document, "MASTER"), master = { volume: number(masterNode, "volume", 0, 100), play: number(masterNode, "play", 0, 1), mute: number(masterNode, "mute", 0, 1, 0) };
  if (master.volume == null || master.play == null) throw new Error("CatSystem2 master sound settings are incomplete.");
  function parts(node, parent = null, depth = 0) {
    if (depth > LIMITS.depth) throw new Error("CatSystem2 sound hierarchy exceeds its depth limit.");
    const result = [];
    for (const source of node.children) {
      if (all.length >= LIMITS.parts || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.name)) throw new Error("CatSystem2 sound parts exceed their limit.");
      const part = { tag: source.name, parent, children: [], mute: parent?.mute ?? 0, explicit: new Set(source.children.map(item => item.name)) };
      for (const [name, range] of Object.entries(NUMERIC)) part[name] = number(source, name, ...range, parent?.[name]);
      for (const name of TEXT) { const text = value(source, name, false); part[name] = text ?? parent?.[name]; if (part[name]?.length > 1024) throw new Error("CatSystem2 sound label exceeds its length limit."); }
      if (part.id == null || part.group == null || !groups.has(part.group) || part.volume == null || part.mastervol == null || part.play == null || part.head == null || part.int == null)
        throw new Error("CatSystem2 sound part has incomplete authored settings.");
      if (result.some(previous => previous.id === part.id)) throw new Error("CatSystem2 sound part ID is repeated within its parent.");
      if (!tags.has(part.tag.toLowerCase())) tags.set(part.tag.toLowerCase(), part); all.push(part); result.push(part);
      const nested = child(source, "part", false); if (nested) part.children = parts(nested, part, depth + 1);
      const allowed = new Set([...Object.keys(NUMERIC), ...TEXT, "part"]);
      if (source.children.some(item => !allowed.has(item.name))) throw new Error("CatSystem2 sound part contains an unsupported setting.");
    }
    return result;
  }
  const roots = parts(child(document, "PART"));
  function select(type, selectors) {
    if (!Array.isArray(selectors)) throw new Error("Bounded CatSystem2 sound selectors are required.");
    if (type === "tag" || type === "type") {
      if (selectors.length !== 1 || typeof selectors[0] !== "string" || !selectors[0].length || selectors[0].length > 1024 || /[\x00-\x1f]/.test(selectors[0])) throw new Error("A bounded CatSystem2 sound selector is required.");
      const name = selectors[0].toLowerCase();
      return type === "tag" ? name === "master" ? master : tags.get(name) : all.find(part => part.type?.toLowerCase() === name);
    }
    if (type === "id") {
      if (!selectors.length || selectors.length > LIMITS.depth || selectors.some(id => !Number.isInteger(id) || id < 0 || id > 65535)) throw new Error("A bounded CatSystem2 sound ID path is required.");
      let candidates = roots, selected;
      for (const id of selectors) { selected = candidates.find(part => part.id === id); if (!selected) return null; candidates = selected.children; } return selected;
    }
    throw new Error("Unsupported CatSystem2 sound selector.");
  }
  function query(name, selectors) {
    const match = /^(volume|play|mute|sysplay|voicebgm)(?:_(id|type))?$/.exec(name); if (!match) throw new Error("Unsupported CatSystem2 sound preference.");
    const part = select(match[2] || "tag", selectors), field = match[1] === "voicebgm" ? "voicevol" : match[1];
    // This engine ABI returns 100 for an absent named volume part. It does
    // not create an alias, modify XML or affect archive selection.
    if (!part && profile && field === "volume" && !match[2]) return 100;
    if (!part || part[field] == null) throw new Error("CatSystem2 sound preference is absent.");
    if (field !== "volume" && part.sameid != null && part.sameid >= 0) throw new Error("This CatSystem2 sound-part identity mode is unsupported."); return part[field];
  }
  function set(name, setting, selectors) {
    const match = /^(volume|play|mute|sysplay|voicebgm)(?:_(id|type))?$/.exec(name);
    if (!match) throw new Error("Unsupported CatSystem2 sound preference.");
    const mode = match[2] || "tag", field = match[1] === "voicebgm" ? "voicevol" : match[1];
    const selected = select(mode, selectors);
    const targets = mode === "id" ? [select(mode, selectors)] : selectors.length === 1 ?
      selected === master ? [master] : all.filter(part => part[mode === "tag" ? "tag" : "type"]?.toLowerCase() === selectors[0].toLowerCase()) : [];
    if (!targets.length || targets.some(part => !part || part[field] == null)) throw new Error("CatSystem2 sound preference is absent.");
    if (field !== "volume" && targets.some(part => part.sameid != null && part.sameid >= 0)) throw new Error("This CatSystem2 sound-part identity mode is unsupported.");
    const maximum = ["volume", "voicevol"].includes(field) ? 100 : 1;
    if (!Number.isInteger(setting) || setting < 0 || setting > maximum) throw new Error("CatSystem2 sound preference exceeds its range.");
    // XML inheritance supplies initial values. Runtime volume changes write the
    // selected part; child preferences remain independently editable.
    for (const target of targets) target[field] = setting;
  }
  function soundFor(file, tag, soundType) {
    if (typeof file !== "string" || !file.length || file.length > 1024 || /[\x00-\x1f]/.test(file)) throw new Error("CatSystem2 sound filename is invalid.");
    if (profile) {
      // The authored hierarchy is traversed in declaration order, testing a
      // nonempty filename prefix before its children. GROUP and STYPE do
      // not redirect this extended sound-part filename lookup.
      const folded = file.toLowerCase(), visit = part => {
        if (part.head && folded.startsWith(part.head.toLowerCase())) return part;
        for (const nested of part.children) { const result = visit(nested); if (result) return result; }
        return null;
      };
      let part = null; for (const root of roots) { part = visit(root); if (part) break; }
      if (!part || !part.int) throw new Error("CatSystem2 sound archive selection is absent.");
      if (part.sameid != null && part.sameid >= 0) throw new Error("CatSystem2 sound setting aliases are unsupported.");
      return part;
    }
    // The original Windows name resolver is case insensitive. STYPE provides
    // the legacy group when an authored GROUP override is absent.
    const group = tag != null ? tags.get(String(tag).toLowerCase()) : roots.find(part => part.type === ["bgm", "se", "voice"][soundType]);
    if (!group) throw new Error("CatSystem2 sound part is absent.");
    const folded = file.toLowerCase(), candidates = [], visit = part => { if (folded.startsWith(part.head.toLowerCase()) && part.int) candidates.push(part); for (const nested of part.children) visit(nested); }; visit(group);
    candidates.sort((a, b) => b.head.length - a.head.length); if (!candidates.length) throw new Error("CatSystem2 sound archive selection is absent.");
    if (candidates.length > 1 && candidates[0].head.length === candidates[1].head.length) throw new Error("CatSystem2 sound archive selection is ambiguous.");
    if (candidates[0].sameid != null && candidates[0].sameid >= 0) throw new Error("CatSystem2 sound setting aliases are unsupported."); return candidates[0];
  }
  return { profile, groups, master, roots, all, tags, query, set, soundFor };
}
module.exports = { LIMITS, PROFILE, parseSoundConfig };
