const fs = require("node:fs");
const path = require("node:path");
const { managedAssembly } = require("./fna-assembly");

function settingsFile(apis = [17], version = "2020.1.17f1") {
  const dataOffset = 256, dataSize = 8 + apis.length * 4, bytes = Buffer.alloc(dataOffset + dataSize);
  bytes.writeUInt32BE(bytes.length, 4); bytes.writeUInt32BE(21, 8); bytes.writeUInt32BE(dataOffset, 12);
  let cursor = 20; bytes.write(version + "\0", cursor); cursor += version.length + 1;
  bytes.writeInt32LE(19, cursor); cursor += 4; bytes[cursor++] = 0;
  bytes.writeInt32LE(1, cursor); cursor += 4; bytes.writeInt32LE(141, cursor); cursor += 4; bytes[cursor++] = 0; bytes.writeInt16LE(-1, cursor); cursor += 18;
  bytes.writeInt32LE(1, cursor); cursor += 4; cursor = Math.ceil(cursor / 4) * 4;
  bytes.writeBigUInt64LE(11n, cursor); cursor += 8; bytes.writeUInt32LE(0, cursor); cursor += 4;
  bytes.writeUInt32LE(dataSize, cursor); cursor += 4; bytes.writeInt32LE(0, cursor); cursor += 4;
  bytes.writeUInt32BE(cursor - 20, 0); bytes.writeInt32LE(apis.length, dataOffset + 4);
  apis.forEach((api, index) => bytes.writeInt32LE(api, dataOffset + 8 + index * 4)); return bytes;
}
function archive(data, version = "2020.1.17f1") {
  const strings = Buffer.from("UnityFS\0\0\0\0\7" + "5.x.x\0" + version + "\0", "binary");
  const headerSize = Math.ceil((strings.length + 20) / 16) * 16, header = Buffer.alloc(headerSize); strings.copy(header);
  const name = Buffer.from("globalgamemanagers\0"), metadata = Buffer.alloc(16 + 4 + 10 + 4 + 20 + name.length);
  metadata.writeUInt32BE(1, 16); metadata.writeUInt32BE(data.length, 20); metadata.writeUInt32BE(data.length, 24); metadata.writeUInt32BE(1, 30);
  metadata.writeBigUInt64BE(BigInt(data.length), 42); name.copy(metadata, 54);
  header.writeBigUInt64BE(BigInt(header.length + metadata.length + data.length), strings.length); header.writeUInt32BE(metadata.length, strings.length + 8);
  header.writeUInt32BE(metadata.length, strings.length + 12); header.writeUInt32BE(64, strings.length + 16);
  return Buffer.concat([header, metadata, data]);
}
function game(root, { apis = [17], bundled = false, nativeImports = [], linux = false, il2cpp = false, version = "2020.1.17f1" } = {}) {
  const file = path.join(root, linux ? "Game.x86_64" : "Game.exe"), data = path.join(root, "Game_Data");
  const executable = Buffer.alloc(64); if (linux) Buffer.from([127, 69, 76, 70]).copy(executable); else executable.write("MZ");
  fs.writeFileSync(file, executable); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, bundled ? "data.unity3d" : "globalgamemanagers"), bundled ? archive(settingsFile(apis, version), version) : settingsFile(apis, version));
  fs.writeFileSync(path.join(data, "app.info"), "Example Company\nExample Product");
  if (il2cpp) { fs.mkdirSync(path.join(data, "il2cpp_data", "Metadata"), { recursive: true }); fs.writeFileSync(path.join(data, "il2cpp_data", "Metadata", "global-metadata.dat"), "metadata"); }
  else { fs.mkdirSync(path.join(data, "Managed")); fs.writeFileSync(path.join(data, "Managed", "UnityEngine.CoreModule.dll"), managedAssembly({ name: "UnityEngine.CoreModule" }));
    fs.writeFileSync(path.join(data, "Managed", "Assembly-CSharp.dll"), managedAssembly({ name: "Assembly-CSharp", entryPoint: false, references: [{ name: "UnityEngine.CoreModule", version: [0, 0, 0, 0] }], nativeImports })); }
  return { file, data };
}

module.exports = { settingsFile, archive, game };
