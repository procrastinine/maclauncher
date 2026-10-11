const fs = require("node:fs");

// Minimal structural PE/CLI inputs for parser tests. These are not runnable
// games and are never used as native runtime or GUI evidence.
function managedAssembly({ name = "Game", version = [1, 2, 3, 4], references = [{ name: "FNA", version: [23, 8, 0, 0] }],
  framework = ".NETCoreApp,Version=v7.0", entryPoint = true, flags = 1, types = [], nativeImports = [], resources = [], machine = 0x14c, pe64 = false, nativeManagedCode = false } = {}) {
  const strings = [Buffer.from([0])]; let stringLength = 1;
  function str(value) { const offset = stringLength, bytes = Buffer.from(value + "\0"); strings.push(bytes); stringLength += bytes.length; return offset; }
  const blobs = [Buffer.from([0])]; let blobLength = 1;
  function blob(value) { if (value.length > 127) throw new Error("Fixture blob is too large."); const offset = blobLength, bytes = Buffer.concat([Buffer.from([value.length]), value]); blobs.push(bytes); blobLength += bytes.length; return offset; }
  function row(...fields) { const bytes = Buffer.alloc(fields.reduce((sum, [size]) => sum + size, 0)); let cursor = 0; for (const [size, value] of fields) { if (size === 2) bytes.writeUInt16LE(value, cursor); else bytes.writeUInt32LE(value, cursor); cursor += size; } return bytes; }
  const tableRows = new Map();
  const typeRows = types.map(type => row([2, 0], [2, str(type.name)], [2, str(type.namespace)]));
  if (framework) {
    const typeIndex = typeRows.push(row([2, 0], [2, str("TargetFrameworkAttribute")], [2, str("System.Runtime.Versioning")]));
    tableRows.set(10, [row([2, (typeIndex << 3) | 1], [2, str(".ctor")], [2, 0])]);
    const value = Buffer.from(framework);
    tableRows.set(12, [row([2, (1 << 5) | 14], [2, (1 << 3) | 3], [2, blob(Buffer.concat([Buffer.from([1, 0, value.length]), value, Buffer.from([0, 0])]))])]);
  }
  if (typeRows.length) tableRows.set(1, typeRows);
  if (entryPoint) tableRows.set(6, [row([4, 0], [2, 0], [2, 0], [2, str("Main")], [2, 0], [2, 1])]);
  if (nativeImports.length) {
    tableRows.set(26, nativeImports.map(imported => row([2, str(imported.library)])));
    tableRows.set(28, nativeImports.map((imported, index) => row([2, 0], [2, 3], [2, str(imported.name)], [2, index + 1])));
  }
  const resourceChunks = []; let resourceLength = 0;
  if (resources.length) tableRows.set(40, resources.map(resource => {
    const bytes = Buffer.from(resource.bytes || []), prefix = Buffer.alloc(4), offset = resourceLength;
    prefix.writeUInt32LE(resource.declaredSize ?? bytes.length);
    resourceChunks.push(prefix, bytes); resourceLength += 4 + bytes.length;
    return row([4, resource.declaredOffset ?? offset], [4, 1], [2, str(resource.name)], [2, resource.implementation || 0]);
  }));
  tableRows.set(32, [row([4, 0], ...version.map(value => [2, value]), [4, 0], [2, 0], [2, str(name)], [2, 0])]);
  if (references.length) tableRows.set(35, references.map(ref => row(...ref.version.map(value => [2, value]), [4, 0], [2, 0], [2, str(ref.name)], [2, 0], [2, 0])));
  const ordered = [...tableRows.keys()].sort((a, b) => a - b);
  const tablesHeader = Buffer.alloc(24 + ordered.length * 4); tablesHeader[4] = 2; tablesHeader[7] = 1;
  tablesHeader.writeBigUInt64LE(ordered.reduce((sum, table) => sum | (1n << BigInt(table)), 0n), 8);
  ordered.forEach((table, index) => tablesHeader.writeUInt32LE(tableRows.get(table).length, 24 + index * 4));
  const tables = Buffer.concat([tablesHeader, ...ordered.flatMap(table => tableRows.get(table))]);
  const versionString = Buffer.alloc(12); versionString.write("v4.0.30319");
  const metadataHeader = Buffer.alloc(16 + versionString.length + 4);
  metadataHeader.writeUInt32LE(0x424a5342); metadataHeader.writeUInt16LE(1, 4); metadataHeader.writeUInt16LE(1, 6);
  metadataHeader.writeUInt32LE(versionString.length, 12); versionString.copy(metadataHeader, 16); metadataHeader.writeUInt16LE(3, 16 + versionString.length + 2);
  const streams = [["#~", tables], ["#Strings", Buffer.concat(strings)], ["#Blob", Buffer.concat(blobs)]];
  const headerSizes = streams.map(([label]) => 8 + ((label.length + 1 + 3) & ~3));
  let offset = metadataHeader.length + headerSizes.reduce((sum, size) => sum + size, 0);
  const streamHeaders = streams.map(([label, bytes], index) => { const header = Buffer.alloc(headerSizes[index]); header.writeUInt32LE(offset); header.writeUInt32LE(bytes.length, 4); header.write(label, 8); offset += bytes.length; return header; });
  const metadata = Buffer.concat([metadataHeader, ...streamHeaders, ...streams.map(([, bytes]) => bytes)]);
  const bytes = Buffer.alloc(512 + 72 + metadata.length + resourceLength);
  const optionalSize = pe64 ? 240 : 224, directories = pe64 ? 112 : 96;
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(optionalSize, 148);
  bytes.writeUInt16LE(pe64 ? 0x20b : 0x10b, 152); bytes.writeUInt32LE(16, 152 + directories - 4); bytes.writeUInt32LE(0x2000, 152 + directories + 14 * 8); bytes.writeUInt32LE(72, 152 + directories + 14 * 8 + 4);
  const section = 152 + optionalSize; bytes.write(".text", section); bytes.writeUInt32LE(0x2000, section + 12); bytes.writeUInt32LE(72 + metadata.length + resourceLength, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(72, 512); bytes.writeUInt32LE(0x2000 + 72, 520); bytes.writeUInt32LE(metadata.length, 524); bytes.writeUInt32LE(flags, 528); bytes.writeUInt32LE(entryPoint ? 0x06000001 : 0, 532);
  if (nativeManagedCode) { bytes.writeUInt32LE(0x2000, 576); bytes.writeUInt32LE(8, 580); }
  metadata.copy(bytes, 584);
  if (resourceLength) {
    bytes.writeUInt32LE(0x2000 + 72 + metadata.length, 536); bytes.writeUInt32LE(resourceLength, 540);
    Buffer.concat(resourceChunks).copy(bytes, 584 + metadata.length);
  }
  return bytes;
}
function writeAssembly(file, options) { fs.writeFileSync(file, managedAssembly(options)); return file; }
module.exports = { managedAssembly, writeAssembly };
