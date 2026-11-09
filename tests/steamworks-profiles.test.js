const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveProfile, selectProfile, normalizeProfileSelection } = require('../src/modules/shared/runtime/steamworks/profiles');
const catalog = require("../src/modules/shared/runtime/included-package-metadata").resolve(require('../src/modules/shared/runtime/steamworks/profiles.json'));
const pins = require("../src/modules/shared/runtime/included-package-metadata").resolve(require('../src/modules/shared/runtime/steamworks/versions.json'));
const pinForProfile = id => pins.find(pin => pin.version === catalog.find(profile =>
  profile.id === normalizeProfileSelection({ abiProfile: id }).abiProfile)?.helperVersion);
const java = require("../src/modules/shared/runtime/included-package-metadata").resolve(require('../src/modules/java/runtime/steamworks/versions.json'));
const greenworks = require('../src/modules/shared/web/runtime/greenworks-contracts.json');
const sdk = require('../src/modules/shared/web/runtime/greenworks-sdk').PIN;

test('saved Goldberg profile choices normalize only to their exact owned-helper counterparts', () => {
  const legacy = ['luasteam-4.0.2-sdk1.63-ml1', 'steamworks4j-1.9.0-ml1', 'steamworks4j-1.10.0-ml1',
    'greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64'];
  for (const abiProfile of legacy) {
    const saved = Object.freeze({ abiProfile, version: 'goldberg-mac-1.0.0-ml1-universal', language: 'english' });
    const normalized = normalizeProfileSelection(saved);
    const target = catalog.find(profile => profile.id === `${abiProfile}-offline-abi0.5.0`);
    assert.deepEqual(normalized, { ...saved, abiProfile: target.id, version: target.helperVersion });
    assert.equal(saved.abiProfile, abiProfile);
    assert.equal(saved.version, 'goldberg-mac-1.0.0-ml1-universal');
    assert.ok(target);
    assert.equal(target.helperVersion, normalized.version);
    assert.equal(catalog.some(profile => profile.id === abiProfile), false);
    assert.equal(normalizeProfileSelection({ abiProfile, version: 'explicit-other-version' }).version, 'explicit-other-version');
  }
  const unknown = { abiProfile: 'unknown-explicit-profile', version: 'goldberg-mac-1.0.0-ml1-universal' };
  assert.equal(normalizeProfileSelection(unknown), unknown);
  assert.equal(pins.some(pin => pin.version.startsWith('goldberg')), false);
});

test('Java bridge versions retain their distinct qualified CPU and interface requirements', () => {
  for (const bridge of java) {
    for (const architecture of bridge.architectures) {
      const pin = pinForProfile(bridge.abiProfile);
      const profile = resolveProfile({ id: bridge.abiProfile, pin, architecture, requiredInterfaces: bridge.interfaces });
      assert.equal(profile.bridgeVersion, bridge.bridgeVersion);
      assert.deepEqual(profile.symbols, bridge.symbols);
      const successorPin = pinForProfile(bridge.helperAbiProfile);
      const successor = resolveProfile({ id: bridge.helperAbiProfile, pin: successorPin, architecture,
        requiredInterfaces: bridge.interfaces });
      assert.equal(successorPin.version, bridge.helperVersion);
      assert.equal(successor.bridgeVersion, profile.bridgeVersion);
      assert.equal(profile.id, bridge.helperAbiProfile);
      assert.equal(successor.helperVersion, profile.helperVersion);
    }
  }
  const pin = pinForProfile('steamworks4j-1.9.0-ml1');
  assert.throws(() => resolveProfile({ id: 'steamworks4j-1.9.0-ml1', pin, architecture: 'arm64' }),
    { code: 'STEAM_API_PROFILE_CHANGED' });
  assert.throws(() => resolveProfile({ id: 'steamworks4j-1.9.0-ml1', pin, architecture: 'x86_64',
    requiredInterfaces: ['SteamUser023'] }), { code: 'STEAM_API_INTERFACES_UNAVAILABLE' });
  assert.throws(() => resolveProfile({ id: 'steamworks4j-1.10.0-ml1', pin, architecture: 'x86_64',
    requiredInterfaces: ['SteamUser021'] }), { code: 'STEAM_API_INTERFACES_UNAVAILABLE' });
});

test('Greenworks offline qualification retains its exact bridge, host, ticket and ARM CPU', () => {
  const contract = greenworks.find(item => item.nwVersion === '0.103.1');
  const pin = pinForProfile(contract.offlineAbiProfile);
  const profile = resolveProfile({ id: contract.offlineAbiProfile, pin, architecture: 'arm64',
    requiredInterfaces: contract.interfaces });
  assert.equal(profile.bridgeVersion, `greenworks-${contract.greenworksVersion}-nw${contract.nwVersion}`);
  assert.equal(profile.hostVersion, contract.nwVersion);
  assert.equal(profile.hostVariant, 'sdk');
  assert.equal(profile.sdkVersion, sdk.sdkVersion);
  assert.equal(profile.minimumMacOS, contract.minimumMacOS);
  assert.deepEqual(profile.symbols, contract.symbols);
  assert.deepEqual(profile.architectures, ['arm64']);
  const successor = resolveProfile({ id: contract.helperAbiProfile, pin: pinForProfile(contract.helperAbiProfile),
    architecture: 'arm64', requiredInterfaces: contract.interfaces });
  assert.equal(successor.helperVersion, selectProfile({ id: contract.helperAbiProfile, architecture: 'arm64' }).pin.version);
  assert.equal(successor.bridgeVersion, profile.bridgeVersion);
  const ticket = require("../src/modules/shared/runtime/included-package-metadata").resolve(require('../src/modules/shared/runtime/steamworks/ticket-versions.json'))
    .find(pin => pin.version === successor.encryptedTicketVersion);
  assert.ok(ticket);
  assert.equal(successor.encryptedTicketPolicy, 'unavailable');
  assert.equal(successor.id, profile.id);
  assert.throws(() => resolveProfile({ id: profile.id, pin, architecture: 'x86_64' }),
    { code: 'STEAM_API_PROFILE_CHANGED' });
});

test('profile selection follows declared helper facts and preserves explicit older choices', () => {
  const original = catalog[0], current = pins.find(pin => pin.version === original.helperVersion);
  const next = {...original, helperVersion: 'next-published-version'};
  const nextPin = {...current, version: next.helperVersion};
  const selected = selectProfile({id: next.id, architecture: next.architectures[0], profiles: [next],
    catalog: [current, nextPin]});
  assert.equal(selected.pin, nextPin, 'An unrelated first catalog entry cannot replace a profile binding');
  const legacy = 'luasteam-4.0.2-sdk1.63-ml1';
  const profile = catalog.find(profile => profile.id === `${legacy}-offline-abi0.5.0`);
  const old = {...profile, helperVersion: '0.5.0'}, oldPin = {...current, version: old.helperVersion};
  const saved = Object.freeze({abiProfile: legacy, version: old.helperVersion});
  const retained = normalizeProfileSelection(saved, {profiles: [old]});
  assert.equal(retained.version, oldPin.version);
  assert.equal(selectProfile({id: retained.abiProfile, version: retained.version, architecture: old.architectures[0],
    profiles: [old], catalog: [nextPin, oldPin]}).pin, oldPin);
  assert.equal(saved.abiProfile, legacy);
});

test('every published ABI profile resolves against its helper and names its bridge or consumer', () => {
  assert.equal(new Set(catalog.map(profile => profile.id)).size, catalog.length);
  for (const profile of catalog) {
    const pin = pinForProfile(profile.id);
    for (const architecture of profile.architectures) resolveProfile({ id: profile.id, pin, architecture });
    if (profile.managedConsumer) {
      const consumer = require('../src/modules/shared/runtime/steamworks/managed-consumer')
        .validateConsumerProfile(profile.managedConsumer);
      assert.match(consumer.assemblySha256, /^[a-f0-9]{64}$/);
      continue;
    }
    if (profile.bridgeVersion !== undefined) assert.match(profile.bridgeVersion, /^[A-Za-z0-9_.-]+$/);
  }
});
