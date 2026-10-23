function record(name, extent, size, directory = false) {
  const encoded = typeof name === "number" ? Buffer.from([name]) : Buffer.from(name, "latin1");
  const length = 33 + encoded.length + (encoded.length % 2 ? 0 : 1), bytes = Buffer.alloc(length);
  bytes[0] = length; bytes.writeUInt32LE(extent, 2); bytes.writeUInt32BE(extent, 6);
  bytes.writeUInt32LE(size, 10); bytes.writeUInt32BE(size, 14); bytes[25] = directory ? 2 : 0;
  bytes.writeUInt16LE(1, 28); bytes.writeUInt16BE(1, 30); bytes[32] = encoded.length; encoded.copy(bytes, 33);
  return bytes;
}

function isoFixture({ raw = false, title = "～この世の果てで恋を唄う少女～", files = {} } = {}) {
  const ini = Buffer.from(`[CONFIG]\nTITLE=${title}\n[FILE]\nbARCMES=1\nARCMESNAME=MES.ARC\n`);
  const originals = { "AI5WIN.INI": ini, ...files }, positions = {}; let next = 24;
  for (const [name, bytes] of Object.entries(originals)) { positions[name] = { extent: next, size: bytes.length }; next += Math.ceil(bytes.length / 2048) || 1; }
  const image = Buffer.alloc((next + 1) * 2048), pvd = image.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1; pvd.write("CD001", 1); pvd[6] = 1;
  pvd.writeUInt32LE(next + 1, 80); pvd.writeUInt32BE(next + 1, 84); pvd.writeUInt16LE(2048, 128); pvd.writeUInt16BE(2048, 130);
  record(0, 20, 2048, true).copy(pvd, 156);
  const root = Buffer.concat([record(0, 20, 2048, true), record(1, 20, 2048, true), record("GAME", 21, 2048, true)]);
  root.copy(image, 20 * 2048);
  const directory = Buffer.concat([record(0, 21, 2048, true), record(1, 20, 2048, true), ...Object.entries(positions).map(([name, item]) => record(name + ";1", item.extent, item.size))]);
  directory.copy(image, 21 * 2048);
  for (const [name, bytes] of Object.entries(originals)) bytes.copy(image, positions[name].extent * 2048);
  if (!raw) return { bytes: image, positions, root: 20 * 2048, directory: 21 * 2048, blockOffset: lba => lba * 2048 };
  const bytes = Buffer.alloc(image.length / 2048 * 2352);
  for (let i = 0; i < image.length / 2048; i++) { bytes.fill(255, i * 2352 + 1, i * 2352 + 11); bytes[i * 2352 + 15] = 1; image.copy(bytes, i * 2352 + 16, i * 2048, (i + 1) * 2048); }
  return { bytes, positions, root: 20 * 2352 + 16, directory: 21 * 2352 + 16, blockOffset: lba => lba * 2352 + 16 };
}

module.exports = { record, isoFixture };
