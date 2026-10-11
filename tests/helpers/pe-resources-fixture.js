const { peFixture } = require("./pe-fixture");

// Authored metadata-only PE tree: resource types/names may be IDs or Unicode
// names. It contains no executable code or publisher/game resource values.
function resourceFixture(resources, { is64 = false } = {}) {
  const basic = peFixture({ is64 }), tree = new Map();
  for (const resource of resources) {
    if (!tree.has(resource.type)) tree.set(resource.type, new Map());
    const names = tree.get(resource.type);
    if (!names.has(resource.name)) names.set(resource.name, []);
    names.get(resource.name).push(resource);
  }
  const bytes = Buffer.alloc(2 * 1024 * 1024); let cursor = 0;
  const allocate = count => { const at = cursor; cursor = Math.ceil((cursor + count) / 4) * 4; return at; };
  const nameOffset = name => {
    if (typeof name === "number") return name;
    const text = Buffer.from(name, "utf16le"), at = allocate(text.length + 2);
    bytes.writeUInt16LE(text.length / 2, at); text.copy(bytes, at + 2); return (at | 0x80000000) >>> 0;
  };
  const branch = entries => {
    const values = [...entries].sort((a, b) => (typeof a[0] === "string" ? 0 : 1) - (typeof b[0] === "string" ? 0 : 1));
    const at = allocate(16 + values.length * 8);
    bytes.writeUInt16LE(values.filter(([name]) => typeof name === "string").length, at + 12);
    bytes.writeUInt16LE(values.filter(([name]) => typeof name !== "string").length, at + 14);
    for (let i = 0; i < values.length; i++) {
      const [name, child] = values[i]; bytes.writeUInt32LE(nameOffset(name), at + 16 + i * 8);
      let offset, directory = true;
      if (child instanceof Map) offset = branch(child);
      else if (Array.isArray(child)) offset = branch(child.map(item => [item.language ?? 1041, item]));
      else {
        directory = false; offset = allocate(16);
        const data = allocate(child.data.length); child.data.copy(bytes, data);
        bytes.writeUInt32LE(0x2000 + data, offset); bytes.writeUInt32LE(child.data.length, offset + 4);
      }
      bytes.writeUInt32LE((offset | (directory ? 0x80000000 : 0)) >>> 0, at + 20 + i * 8);
    }
    return at;
  };
  branch(tree);
  const output = Buffer.alloc(basic.raw + cursor); basic.bytes.copy(output, 0, 0, basic.raw); bytes.copy(output, basic.raw, 0, cursor);
  output.writeUInt32LE(cursor, basic.directories + 20); output.writeUInt32LE(cursor, basic.section + 8); output.writeUInt32LE(cursor, basic.section + 16);
  return { ...basic, bytes: output, resourceSize: cursor };
}

module.exports = { resourceFixture };
