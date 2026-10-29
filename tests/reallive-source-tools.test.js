const test = require("node:test");
const assert = require("node:assert/strict");
const { realLiveProfile } = require("../src/modules/siglus/source-profile");
const { __test: { diagnostics } } = require("../src/modules/siglus/rldev-tools");

const profile = overrides => ({ engineKind: "reallive", format: "RealLive SEEN", detectedVersion: "1.6.7.3",
  registryName: "KEY\\CLANNAD_ENHD", samples: [{ headerSize: 464, compilerVersion: 10002, secondaryXor: false }], ...overrides });

test("RealLive source recovery uses exact runtime metadata and refuses unknown secondary keys", () => {
  assert.deepEqual(realLiveProfile(profile()), { version: "1.6.7.3", gameId: null });
  const protectedSamples = [{ headerSize: 464, compilerVersion: 110002, secondaryXor: true }];
  assert.equal(realLiveProfile(profile({ samples: protectedSamples })), null);
  assert.deepEqual(realLiveProfile(profile({ samples: protectedSamples, registryName: "KEY\\CLANNAD_FV", detectedVersion: "1.5.0.4" })),
    { version: "1.5.0.4", gameId: "CFV" });
  for (const changes of [{ format: "RealLive loose scenario" }, { detectedVersion: null }, { engineKind: "avg32" },
    { samples: [{ headerSize: 464, compilerVersion: 120002 }] }, { samples: [] }]) assert.equal(realLiveProfile(profile(changes)), null);
});

test("RealLive diagnostics retain aborted scenarios even when the upstream process exits successfully", () => {
  const failures = diagnostics("Warning: SEEN0425.TXT: disassembly aborted at offset 0x1234\n" +
    "Warning: SEEN0425.TXT: context @0x1234: 01 02 03\n" +
    "Warning: SEEN1002.TXT: unknown opcode 01\n" +
    "ordinary progress\n");
  assert.deepEqual(failures, [{ script: "SEEN0425.TXT", reason: "disassembly aborted at offset 0x1234" },
    { script: "SEEN1002.TXT", reason: "unknown opcode 01" }]);
  assert.deepEqual(diagnostics("Successfully extracted 235 sources.\n"), []);
});
