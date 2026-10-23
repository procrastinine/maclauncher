const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSteamLicenses, parseAppInfoCache } = require('../src/core/steam-client-library');

test('client license parsing includes active family games, excludes revoked licenses and favors owned access', () => {
  const text = `[2026-10-20 10:00:00] License packageID 1:\r\n[2026-10-20 10:00:00] - State: Active, Borrowed\r\n - Purchased: Family Group\r\n - Apps :\r\n42,\r\n44,\r\n (2 in total)\r\n - Depots :\r\n999,\r\nLicense packageID 2:\r\n - State: Active\r\n - Apps: 42, 43, (2 in total)\r\nLicense packageID 3:\r\n - State: Revoked\r\n - Apps: 45, (1 in total)`;
  assert.deepEqual(parseSteamLicenses(text), [{ appId: 42, shared: false }, { appId: 44, shared: true }, { appId: 43, shared: false }]);
});

test('modern app cache resolves interned keys and rejects truncated records', () => {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const keys = ['appinfo', 'common', 'name', 'type', 'oslist'];
  const prop = (key, value) => Buffer.concat([Buffer.from([1]), u32(keys.indexOf(key)), Buffer.from(value + '\0')]);
  const dict = (key, entries) => Buffer.concat([Buffer.from([0]), u32(keys.indexOf(key)), ...entries, Buffer.from([8])]);
  const data = Buffer.concat([dict('appinfo', [dict('common', [prop('name', 'Example'), prop('type', 'game'), prop('oslist', 'windows,macos')])]), Buffer.from([8])]);
  const entry = Buffer.concat([u32(42), u32(60 + data.length), Buffer.alloc(60), data, u32(0)]);
  const header = Buffer.alloc(16); header.writeUInt32LE(0x07564429); header.writeUInt32LE(1, 4); header.writeBigUInt64LE(BigInt(16 + entry.length), 8);
  const file = Buffer.concat([header, entry, u32(keys.length), ...keys.map(key => Buffer.from(key + '\0'))]);
  assert.equal(parseAppInfoCache(file).get(42).common.name, 'Example');
  assert.equal(parseAppInfoCache(file).get(42).common.oslist, 'windows,macos');
  assert.throws(() => parseAppInfoCache(file.subarray(0, 30)), /key table|Incomplete|Invalid/i);
});
