const assert = require("node:assert/strict");
const {createRequire} = require("node:module");
const test = require("node:test");

const steamRequire = createRequire(require.resolve("steam-user/package.json"));
const ticketRequire = createRequire(steamRequire.resolve("steam-appticket/package.json"));

test("Steam's generated app-ticket schema preserves unsigned fields and binary payloads", () => {
  const {EncryptedAppTicket} = ticketRequire("./protobufs/generated/_load.js");
  const input = {ticket_version_no: 2, crc_encryptedticket: 0xfedcba98,
    cb_encrypteduserdata: 3, cb_encrypted_appownershipticket: 512,
    encrypted_ticket: Buffer.from([0, 255, 128, 1, 0, 42])};
  assert.equal(EncryptedAppTicket.verify(input), null);
  const encoded = EncryptedAppTicket.encode(input).finish();
  const decoded = EncryptedAppTicket.toObject(EncryptedAppTicket.decode(encoded), {bytes: Buffer});
  assert.deepEqual(decoded, input);
  assert.deepEqual(EncryptedAppTicket.encodeDelimited(input).finish(),
    Buffer.concat([Buffer.from([encoded.length]), encoded]));
  assert.throws(() => EncryptedAppTicket.decode(encoded.subarray(0, encoded.length - 1)));
  assert.equal(ticketRequire("./index.js").parseEncryptedAppTicket(Buffer.from([255]), Buffer.alloc(32)), null);
});

test("Steam's CDN ZIP decoder reads original bytes and rejects damaged downloads", async () => {
  const Zip = steamRequire("adm-zip");
  const {unzip} = steamRequire("./components/cdn_compression.js");
  const bytes = Buffer.from("Steam CDN payload\0\xff", "latin1"), zip = new Zip();
  zip.addFile("chunk.bin", bytes);
  const archive = zip.toBuffer();
  assert.deepEqual(await unzip(archive), bytes);
  await assert.rejects(unzip(archive.subarray(0, archive.length - 8)));
  const damaged = Buffer.from(archive), offset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
  damaged[offset] ^= 0xff;
  await assert.rejects(unzip(damaged));
});
