const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
function slice(startToken, endToken) {
  const start = source.indexOf(startToken), end = source.indexOf(endToken, start);
  assert(start >= 0 && end > start, `${startToken} is in main.js`);
  return source.slice(start, end);
}

function playFixture() {
  let finishCheck;
  const checking = new Promise(resolve => { finishCheck = resolve; });
  const activity = [], launches = [];
  const gamePreparations = new Map();
  const context = {
    gamePreparations, pendingGameCompletions: new Map([["/Games/Slow", { code: 1 }]]),
    gameLaunchNotices: new Map(), graphicsLaunchWarnings: new Map(), cachedState: null, userDataDir: "/data",
    assertGameNotRemoving: () => {}, prioritizeLibraryEntry: () => {},
    assertGameFilesAvailable: async () => {
      const availability = await checking;
      if (!availability.available) throw new Error("The game's files are unavailable.");
    },
    broadcastActivity: () => activity.push(JSON.parse(JSON.stringify(Object.fromEntries(gamePreparations)))),
    ReShade: { executionRequirements: () => ({ needed: { processor: false } }) },
    StoredPlan: { read: () => ({ source: "effects" }), notices: () => [] },
    backendService: { launchEntry: async (entry, options) => { launches.push(`${entry.gamePath} ${options.runtimeId}`); return { kind: "cancelled" }; } },
    loadSettings: () => ({}), require
  };
  vm.runInNewContext(slice("async function runGameEntry(", "\nasync function runGameByPath("), context);
  return { context, activity, launches, finishCheck };
}

test("Play shows the game as starting before its file check returns", async () => {
  const f = playFixture(), entry = { gamePath: "/Games/Slow", runtimeId: "player" };
  const playing = f.context.runGameEntry(entry, "player");
  assert.deepEqual(f.activity, [{ "/Games/Slow": { phase: "check", label: "Starting game…" } }],
    "the starting state is broadcast while the drive is still being checked");
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), true, "an earlier run's diagnostics stay until the files are known");
  f.finishCheck({ available: true });
  assert.equal(await playing, false);
  assert.deepEqual(f.launches, ["/Games/Slow player"]);
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), false);
  assert.equal(f.context.gamePreparations.size, 0);
  assert.deepEqual(f.activity.at(-1), {});
});

test("Play clears the starting state when the game's files are unavailable", async () => {
  const f = playFixture();
  const playing = f.context.runGameEntry({ gamePath: "/Games/Slow" }, "player");
  assert.equal(f.context.gamePreparations.has("/Games/Slow"), true);
  f.finishCheck({ available: false });
  await assert.rejects(playing, /files are unavailable/);
  assert.deepEqual(f.launches, []);
  assert.equal(f.context.gamePreparations.size, 0);
  assert.deepEqual(f.activity.at(-1), {});
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), true);
});
