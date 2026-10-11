const fs = require("node:fs");

// ECMA-335 metadata tables through GenericParamConstraint. Detection never loads
// or executes a game assembly. Coded indices are sized from the complete row map.
const CODED = {
  ResolutionScope: [2, [0, 26, 35, 1]], TypeDefOrRef: [2, [2, 1, 27]],
  MemberRefParent: [3, [2, 1, 26, 6, 27]], HasConstant: [2, [4, 8, 23]],
  HasCustomAttribute: [5, [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43]],
  CustomAttributeType: [3, [6, 10]], HasFieldMarshal: [1, [4, 8]],
  HasDeclSecurity: [2, [2, 6, 32]], HasSemantics: [1, [20, 23]],
  MethodDefOrRef: [1, [6, 10]], MemberForwarded: [1, [4, 6]],
  Implementation: [2, [38, 35, 39]], TypeOrMethodDef: [1, [2, 6]]
};
const SCHEMAS = [
  [2,"s","g","g","g"], ["ResolutionScope","s","s"], [4,"s","s","TypeDefOrRef","t4","t6"],
  ["t4"], [2,"s","b"], ["t6"], [4,2,2,"s","b","t8"], ["t8"], [2,2,"s"],
  ["t2","TypeDefOrRef"], ["MemberRefParent","s","b"], [2,"HasConstant","b"],
  ["HasCustomAttribute","CustomAttributeType","b"], ["HasFieldMarshal","b"],
  [2,"HasDeclSecurity","b"], [2,4,"t2"], [4,"t4"], ["b"], ["t2","t20"], ["t20"],
  [2,"s","TypeDefOrRef"], ["t2","t23"], ["t23"], [2,"s","b"], [2,"t6","HasSemantics"],
  ["t2","MethodDefOrRef","MethodDefOrRef"], ["s"], ["b"], [2,"MemberForwarded","s","t26"],
  [4,"t4"], [4,4], [4], [4,2,2,2,2,4,"b","s","s"], [4], [4,4,4],
  [2,2,2,2,4,"b","s","s","b"], [4,"t35"], [4,4,4,"t35"], [4,"s","b"],
  [4,4,"s","s","Implementation"], [4,4,"s","Implementation"], ["t2","t2"],
  [2,2,"TypeOrMethodDef","s"], ["MethodDefOrRef","b"], ["t42","TypeDefOrRef"]
];

function inspectManagedAssembly(filePath, { maxMetadataBytes = 8 * 1024 * 1024, detection, range, includeEmbeddedResources = false } = {}) {
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 24 || maxMetadataBytes > 64 * 1024 * 1024) throw new Error("Invalid managed metadata bound.");
  const stat = detection?.stat ? detection.stat(filePath) : fs.statSync(filePath);
  if (!stat?.isFile() || stat.size < 256) throw new Error("Managed game assembly is too small.");
  const start = range?.offset ?? 0, size = range?.size ?? stat.size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 256 || start > stat.size - size) throw new Error("Invalid managed assembly byte range.");
  const fd = detection?.readBytes ? null : fs.openSync(filePath, "r");
  try {
    function read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size - length) throw new Error("Truncated managed game assembly.");
      if (detection?.readBytes) {
        const chunks = [];
        for (let position = 0; position < length; position += 2 * 1024 * 1024) {
          const count = Math.min(length - position, 2 * 1024 * 1024), chunk = detection.readBytes(filePath, start + offset + position, count);
          if (!chunk || chunk.length !== count) throw new Error("Truncated managed game assembly.");
          chunks.push(chunk);
        }
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      }
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, start + offset) !== length) throw new Error("Truncated managed game assembly.");
      return bytes;
    }
    const dos = read(0, 64);
    if (dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Game is not a PE managed assembly.");
    const peOffset = dos.readUInt32LE(60);
    const coff = read(peOffset, 24);
    if (coff.readUInt32LE(0) !== 0x4550) throw new Error("Invalid PE signature.");
    const sectionsCount = coff.readUInt16LE(6), optionalSize = coff.readUInt16LE(20);
    if (!sectionsCount || sectionsCount > 96 || optionalSize < 224 || optionalSize > 4096) throw new Error("Invalid PE section or optional header.");
    const optional = read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
    if (directoriesOffset < 0 || optionalSize < directoriesOffset + 15 * 8 || optional.readUInt32LE(directoriesOffset - 4) < 15) throw new Error("Invalid PE optional header.");
    const sectionBytes = read(peOffset + 24 + optionalSize, sectionsCount * 40);
    function rvaOffset(rva, length) {
      for (let index = 0; index < sectionsCount; index++) {
        const row = sectionBytes.subarray(index * 40, index * 40 + 40);
        const start = row.readUInt32LE(12), size = row.readUInt32LE(16), raw = row.readUInt32LE(20);
        if (rva >= start && rva - start <= size - length) return raw + rva - start;
      }
      throw new Error("Managed metadata RVA is outside file-backed PE sections.");
    }
    const cliRva = optional.readUInt32LE(directoriesOffset + 14 * 8);
    const cliSize = optional.readUInt32LE(directoriesOffset + 14 * 8 + 4);
    if (!cliRva || cliSize < 72) throw new Error("PE does not contain a complete CLR header.");
    const cli = read(rvaOffset(cliRva, 72), 72);
    if (cli.readUInt32LE(0) < 72 || cli.readUInt32LE(0) > cliSize) throw new Error("Invalid CLR header size.");
    const metadataSize = cli.readUInt32LE(12), flags = cli.readUInt32LE(16), entryPointToken = cli.readUInt32LE(20);
    if (metadataSize < 24 || metadataSize > maxMetadataBytes) throw new Error("Managed metadata exceeds supported bounds.");
    const metadata = read(rvaOffset(cli.readUInt32LE(8), metadataSize), metadataSize);
    if (metadata.readUInt32LE(0) !== 0x424a5342) throw new Error("Invalid CLR metadata signature.");
    const versionLength = metadata.readUInt32LE(12);
    if (!versionLength || versionLength > 256 || 16 + versionLength + 4 > metadata.length) throw new Error("Invalid CLR metadata version.");
    const clrMetadataVersion = metadata.toString("utf8", 16, 16 + versionLength).replace(/\0.*$/, "");
    let cursor = (16 + versionLength + 3) & ~3;
    const streamCount = metadata.readUInt16LE(cursor + 2); cursor += 4;
    if (!streamCount || streamCount > 32) throw new Error("Invalid managed metadata streams.");
    const streams = {};
    for (let index = 0; index < streamCount; index++) {
      if (cursor + 9 > metadata.length) throw new Error("Truncated managed metadata stream header.");
      const offset = metadata.readUInt32LE(cursor), size = metadata.readUInt32LE(cursor + 4);
      const end = metadata.indexOf(0, cursor + 8);
      if (end < cursor + 8 || end > cursor + 40 || offset + size > metadata.length) throw new Error("Invalid managed metadata stream range.");
      const name = metadata.toString("ascii", cursor + 8, end);
      if (streams[name]) throw new Error("Duplicate managed metadata stream.");
      streams[name] = metadata.subarray(offset, offset + size);
      cursor = (end + 4) & ~3;
    }
    const tables = streams["#~"] || streams["#-"], strings = streams["#Strings"], blobs = streams["#Blob"];
    if (!tables || tables.length < 24 || !strings || !blobs) throw new Error("Required managed metadata streams are missing.");
    const heapFlags = tables[6], valid = tables.readBigUInt64LE(8), counts = Array(64).fill(0);
    cursor = 24;
    for (let table = 0; table < 64; table++) {
      if (!(valid & (1n << BigInt(table)))) continue;
      if (cursor + 4 > tables.length) throw new Error("Truncated managed metadata row counts.");
      counts[table] = tables.readUInt32LE(cursor); cursor += 4;
      if (counts[table] > 1000000 || (counts[table] && !SCHEMAS[table])) throw new Error("Unsupported managed metadata table.");
    }
    function width(kind) {
      if (typeof kind === "number") return kind;
      if (kind === "s") return heapFlags & 1 ? 4 : 2;
      if (kind === "g") return heapFlags & 2 ? 4 : 2;
      if (kind === "b") return heapFlags & 4 ? 4 : 2;
      if (kind.startsWith("t")) return counts[Number(kind.slice(1))] >= 65536 ? 4 : 2;
      const [bits, choices] = CODED[kind];
      return choices.some(table => counts[table] >= (1 << (16 - bits))) ? 4 : 2;
    }
    const offsets = [], rowWidths = [];
    for (let table = 0; table < SCHEMAS.length; table++) {
      offsets[table] = cursor;
      rowWidths[table] = SCHEMAS[table].reduce((sum, item) => sum + width(item), 0);
      cursor += rowWidths[table] * counts[table];
      if (cursor > tables.length) throw new Error("Truncated managed metadata rows.");
    }
    function row(table, number) {
      if (!number || number > counts[table]) throw new Error("Invalid managed metadata row reference.");
      let position = offsets[table] + (number - 1) * rowWidths[table];
      return SCHEMAS[table].map(kind => { const size = width(kind); const value = size === 2 ? tables.readUInt16LE(position) : tables.readUInt32LE(position); position += size; return value; });
    }
    function string(index) {
      if (index === 0) return "";
      if (index >= strings.length) throw new Error("Invalid managed metadata string index.");
      const end = strings.indexOf(0, index);
      if (end < index || end - index > 4096) throw new Error("Invalid managed metadata string.");
      return strings.toString("utf8", index, end);
    }
    function compressed(bytes, index) {
      const first = bytes[index];
      if (first === undefined) throw new Error("Truncated compressed metadata integer.");
      if (!(first & 0x80)) return [first, index + 1];
      if ((first & 0xc0) === 0x80 && index + 2 <= bytes.length) return [((first & 0x3f) << 8) | bytes[index + 1], index + 2];
      if ((first & 0xe0) === 0xc0 && index + 4 <= bytes.length) return [((first & 0x1f) * 16777216) + bytes.readUIntBE(index + 1, 3), index + 4];
      throw new Error("Invalid compressed metadata integer.");
    }
    function blob(index) {
      if (!index) return Buffer.alloc(0);
      const [length, start] = compressed(blobs, index);
      if (length > 1024 * 1024 || start + length > blobs.length) throw new Error("Invalid managed metadata blob.");
      return blobs.subarray(start, start + length);
    }
    const version = values => values.join(".");
    const assembly = counts[32] ? row(32, 1) : null;
    if (counts[32] > 1) throw new Error("Managed assembly has multiple identities.");
    if (entryPointToken && !(flags & 0x10) && ((entryPointToken >>> 24) !== 6 ||
        !(entryPointToken & 0xffffff) || (entryPointToken & 0xffffff) > counts[6])) throw new Error("Invalid managed entry point token.");
    const references = [];
    if (counts[35] > 4096) throw new Error("Managed assembly has too many references.");
    for (let index = 1; index <= counts[35]; index++) {
      const fields = row(35, index);
      references.push({ name: string(fields[6]), version: version(fields.slice(0, 4)), publicKeyOrToken: blob(fields[5]).toString("hex") });
    }
    const typeReferences = [];
    if (counts[1] > 16384) throw new Error("Managed assembly has too many type references.");
    for (let index = 1; index <= counts[1]; index++) {
      const fields = row(1, index);
      typeReferences.push({ name: string(fields[1]), namespace: string(fields[2]) });
    }
    const nativeImports = [];
    if (counts[26] > 1024 || counts[28] > 4096) throw new Error("Managed assembly has too many native imports.");
    for (let index = 1; index <= counts[28]; index++) {
      const fields = row(28, index), library = row(26, fields[3]);
      nativeImports.push({ library: string(library[0]), name: string(fields[2]) });
    }
    let targetFramework = null;
    for (let index = 1; index <= counts[12]; index++) {
      const fields = row(12, index);
      if (fields[0] !== ((1 << 5) | 14) || (fields[1] & 7) !== 3) continue;
      const member = row(10, fields[1] >>> 3);
      if ((member[0] & 7) !== 1) continue;
      const type = row(1, member[0] >>> 3);
      if (string(type[1]) !== "TargetFrameworkAttribute" || string(type[2]) !== "System.Runtime.Versioning") continue;
      const value = blob(fields[2]);
      if (value.length < 3 || value.readUInt16LE(0) !== 1 || value[2] === 0xff) continue;
      const [length, start] = compressed(value, 2);
      if (length > 1024 || start + length > value.length) throw new Error("Invalid target framework metadata.");
      targetFramework = value.toString("utf8", start, start + length);
      break;
    }
    const embeddedResources = [];
    if (includeEmbeddedResources) {
      if (counts[40] > 2048) throw new Error("Managed assembly has too many resources.");
      const resourcesRva = cli.readUInt32LE(24), resourcesSize = cli.readUInt32LE(28);
      for (let index = 1; index <= counts[40]; index++) {
        const fields = row(40, index), name = string(fields[2]);
        if (!/\.dll(?:\.(?:compressed|deflate|gz))?$/i.test(name)) continue;
        if (fields[3]) { embeddedResources.push({ name, format: "external", reason: "Assembly resource is stored outside this PE." }); continue; }
        try {
          const offset = fields[0];
          if (!resourcesRva || offset > resourcesSize - 4) throw new Error("Assembly resource offset is outside the CLR resource directory.");
          const prefixOffset = rvaOffset(resourcesRva + offset, 4), length = read(prefixOffset, 4).readUInt32LE(0);
          if (length < 2 || length > resourcesSize - offset - 4) throw new Error("Assembly resource size is outside the CLR resource directory.");
          const dataOffset = rvaOffset(resourcesRva + offset + 4, length), prefix = read(dataOffset, Math.min(length, 4));
          const compressed = /\.(?:compressed|deflate|gz)$/i.test(name) || prefix[0] === 0x1f && prefix[1] === 0x8b;
          embeddedResources.push({ name, offset: start + dataOffset, size: length,
            format: prefix.toString("ascii", 0, 2) === "MZ" ? "pe" : compressed ? "compressed" : "unknown" });
        } catch (error) {
          if (error.code === "DETECTION_LIMIT") throw error;
          embeddedResources.push({ name, format: "invalid", reason: error.message });
        }
      }
    }
    return { assemblyName: assembly ? string(assembly[7]) : null,
      assemblyVersion: assembly ? version(assembly.slice(1, 5)) : null,
      clrMetadataVersion, targetFramework, references, typeReferences, nativeImports, peMachine: coff.readUInt16LE(4), peFormat: magic === 0x20b ? "PE32+" : "PE32",
      hasNativeManagedCode: Boolean(cli.readUInt32LE(64) || cli.readUInt32LE(68)),
      ilOnly: Boolean(flags & 1), requires32Bit: Boolean(flags & 2), prefer32Bit: Boolean(flags & 0x20000),
      nativeEntryPoint: Boolean(flags & 0x10), entryPointToken,
      hasEntryPoint: Boolean(entryPointToken && !(flags & 0x10)), metadataBytes: metadataSize,
      ...(includeEmbeddedResources ? { embeddedResources } : {}) };
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function retargetIlAssembly(filePath, architecture = "arm64") {
  if (architecture !== "arm64") throw new Error("Unsupported managed assembly retarget architecture.");
  const info = inspectManagedAssembly(filePath);
  if (!info.ilOnly || info.requires32Bit || info.nativeEntryPoint || info.hasNativeManagedCode) throw new Error("Architecture conversion requires pure 64-bit-capable IL without ReadyToRun/native code.");
  if (info.peMachine !== 0x8664 || info.peFormat !== "PE32+") throw new Error("Architecture conversion only supports x64 PE32+ IL assemblies.");
  const fd = fs.openSync(filePath, "r+");
  try {
    const dos = Buffer.alloc(64); fs.readSync(fd, dos, 0, dos.length, 0);
    const machine = Buffer.alloc(2); machine.writeUInt16LE(0xaa64);
    fs.writeSync(fd, machine, 0, machine.length, dos.readUInt32LE(60) + 4);
  } finally { fs.closeSync(fd); }
  return { ...info, peMachine: 0xaa64, originalMachine: info.peMachine };
}

module.exports = { inspectManagedAssembly, retargetIlAssembly };
