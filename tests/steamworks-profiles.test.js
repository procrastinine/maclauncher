const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { resolveProfile } = require('../src/modules/shared/runtime/steamworks/profiles');
const catalog = require('../src/modules/shared/runtime/steamworks/profiles.json');
const pins = require('../src/modules/shared/runtime/steamworks/versions.json');
const pinForProfile = id => pins.find(pin => pin.version === catalog.find(profile => profile.id === id)?.helperVersion);
const java = require('../src/modules/java/runtime/steamworks/versions.json');
const greenworks = require('../src/modules/shared/web/runtime/greenworks-contracts.json');
const sdk = require('../src/modules/shared/web/runtime/greenworks-sdk').PIN;

test('Java bridge versions retain their distinct qualified CPU and interface requirements', () => {
  for (const bridge of java) {
    for (const architecture of bridge.architectures) {
      const pin = pinForProfile(bridge.abiProfile);
      const profile = resolveProfile({ id: bridge.abiProfile, pin, architecture, requiredInterfaces: bridge.interfaces });
      assert.equal(profile.bridgeVersion, bridge.bridgeVersion);
      assert.equal(profile.bridgeLibrarySha256, bridge.jniSha256);
      assert.equal(profile.bridgePublisherJarSha256, bridge.publisherJarSha256);
      assert.equal(profile.loaderAgentSha256, bridge.agentSha256);
      assert.deepEqual(profile.symbols, bridge.symbols);
      const successorPin = pinForProfile(bridge.helperAbiProfile);
      const successor = resolveProfile({ id: bridge.helperAbiProfile, pin: successorPin, architecture,
        requiredInterfaces: bridge.interfaces });
      assert.equal(successorPin.version, bridge.helperVersion);
      for (const key of ['bridgeVersion', 'bridgeLibrarySha256', 'bridgePublisherJarSha256', 'loaderAgentSha256']) {
        assert.equal(successor[key], profile[key]);
      }
      assert.notEqual(successor.helperVersion, profile.helperVersion);
      assert.throws(() => resolveProfile({ id: bridge.abiProfile, pin: successorPin, architecture }),
        { code: 'STEAM_API_PROFILE_CHANGED' });
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
  assert.equal(profile.bridgeLibrarySha256, contract.nativeSha256);
  assert.equal(profile.bridgeJavascriptSha256, contract.javascriptSha256);
  assert.equal(profile.hostVersion, contract.nwVersion);
  assert.equal(profile.hostVariant, 'sdk');
  assert.equal(profile.sdkVersion, sdk.sdkVersion);
  assert.equal(profile.encryptedTicketLibrarySha256, sdk.sha256);
  assert.equal(profile.minimumMacOS, contract.minimumMacOS);
  assert.deepEqual(profile.symbols, contract.symbols);
  assert.deepEqual(profile.architectures, ['arm64']);
  const successor = resolveProfile({ id: contract.helperAbiProfile, pin: pinForProfile(contract.helperAbiProfile),
    architecture: 'arm64', requiredInterfaces: contract.interfaces });
  assert.equal(successor.helperVersion, contract.helperVersion);
  assert.equal(successor.bridgeLibrarySha256, profile.bridgeLibrarySha256);
  assert.equal(successor.bridgeJavascriptSha256, profile.bridgeJavascriptSha256);
  assert.equal(successor.encryptedTicketVersion, contract.ticketVersion);
  assert.equal(successor.encryptedTicketPolicy, 'unavailable');
  assert.notEqual(successor.encryptedTicketLibrarySha256, profile.encryptedTicketLibrarySha256);
  assert.throws(() => resolveProfile({ id: profile.id, pin, architecture: 'x86_64' }),
    { code: 'STEAM_API_PROFILE_CHANGED' });
  assert.throws(() => resolveProfile({ id: profile.id, pin: { ...pin, librarySha256: '0'.repeat(64) }, architecture: 'arm64' }),
    { code: 'STEAM_API_PROFILE_CHANGED' });
});

test('every published ABI profile is tied to its exact sealed helper and unchanged probe sources', () => {
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
    if (profile.consumerVersion) {
      assert.equal(profile.consumerVersion, '1.4.9999');
      assert.match(profile.consumerSha256, /^[a-f0-9]{64}$/);
      continue;
    }
    assert.ok(profile.probeSources.length);
    for (const source of profile.probeSources) {
      assert.match(source.path, /^src\/modules\/(?:java|love|shared\/web)\/runtime\/[A-Za-z0-9_./-]+$/);
      assert.equal(source.path.includes('..'), false);
      const bytes = fs.readFileSync(path.resolve(__dirname, '..', source.path));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), source.sha256);
    }
  }
});
