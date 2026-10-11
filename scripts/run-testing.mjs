import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, ".local", "testing.json");
const configRel = path.relative(repoRoot, configPath) || ".local/testing.json";
const docRel = ".local/testing.md";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadConfig({ optional = false } = {}) {
  if (!fs.existsSync(configPath)) {
    if (optional) return {};
    fail(`Missing ${configRel}. See ${docRel} for setup.`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    fail(`Failed to read ${configRel}: ${err.message}`);
  }
  let config = null;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    fail(`Invalid JSON in ${configRel}: ${err.message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail(`Invalid ${configRel}: expected a JSON object.`);
  }
  return config;
}

function resolveLocalPath(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.join(repoRoot, trimmed);
}

function runTests(config) {
  const pattern = typeof config.testPattern === "string" && config.testPattern.trim()
    ? config.testPattern.trim()
    : "tests/*.test.js";
  const res = spawnSync(process.execPath, [
    "--test", ...process.argv.slice(3), pattern
  ], {
    stdio: "inherit",
    cwd: repoRoot
  });
  if (res.error) fail(res.error.message);
  process.exit(res.status ?? 1);
}

function runSmoke(config) {
  const games = Array.isArray(config.smokeGames) ? config.smokeGames : [];
  if (!games.length) {
    fail(`Set "smokeGames" in ${configRel}. See ${docRel}.`);
  }
  const runGame = path.join(repoRoot, "scripts", "run-game.mjs");
  for (const game of games) {
    const resolved = resolveLocalPath(game);
    if (!resolved) {
      fail(`Invalid smoke game entry in ${configRel}.`);
    }
    const res = spawnSync(process.execPath, [runGame, "--smoke", "--game", resolved], {
      stdio: "inherit",
      cwd: repoRoot
    });
    if (res.error) fail(res.error.message);
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
  }
}

if (mode === "test") {
  runTests(loadConfig({ optional: true }));
} else if (mode === "smoke") {
  runSmoke(loadConfig());
} else {
  fail("Usage: node scripts/run-testing.mjs <test|smoke>");
}
