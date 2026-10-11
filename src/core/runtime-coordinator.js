const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { mergeSettingsChanges } = require("./settings-merge");

function coordinationError(code, message) { return Object.assign(new Error(message), { code }); }
function runtimeIdentity(value) {
  if (!value || typeof value.managerId !== "string" || !value.managerId.trim()) throw new TypeError("A runtime identity needs a managerId.");
  const identity = { managerId: value.managerId.trim() };
  for (const key of ["version", "sectionId", "variant"]) {
    if (value[key] != null && String(value[key]).trim()) identity[key] = String(value[key]).trim();
  }
  if (identity.version) identity.version = identity.version.replace(/^v(?=\d)/i, "");
  if (value.sourcePath != null) {
    if (typeof value.sourcePath !== "string" || !path.isAbsolute(value.sourcePath)) throw new TypeError("Runtime sourcePath must be absolute.");
    identity.sourcePath = path.resolve(value.sourcePath);
  }
  return identity;
}
function containsPath(root, file) { return root === file || file.startsWith(root + path.sep); }
function conflicts(a, b) {
  if (a.managerId !== b.managerId) return false;
  if (a.sourcePath && b.sourcePath && (containsPath(a.sourcePath, b.sourcePath) || containsPath(b.sourcePath, a.sourcePath))) return true;
  for (const key of ["version", "sectionId", "variant"]) if (a[key] && b[key] && a[key] !== b[key]) return false;
  return true;
}
async function isRuntimeProcessAlive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  if (process.platform === "win32") return true;
  // A worker can close the libuv child watcher before its process exits. Such a
  // child may remain an OS zombie, which kill(pid, 0) reports as present.
  return new Promise(resolve => execFile("/bin/ps", ["-o", "stat=", "-p", String(pid)], { timeout: 1000 }, (error, stdout) => {
    const state = String(stdout || "").trim();
    resolve(state ? !state.startsWith("Z") : Boolean(error && error.code !== 1));
  }));
}

/** Pure Node host. Only bookkeeping and short JSON commits run here; jobs stay in workers. */
function createRuntimeCoordinator({ userDataDir, isProcessAlive = isRuntimeProcessAlive, orphanPollMs = 1000 } = {}) {
  const active = new Map(), pending = [], closedOwners = new Set();
  const gameActivity = new Map(), removedGames = new Set();
  let orphanTimer;
  const overlap = (a, b) => a.identities.some(left => b.identities.some(right => conflicts(left, right)));
  const ownPreparationUse = (request, lease) => lease.kind === "use" && lease.owner === request.owner &&
    lease.pids.size === 0 && request.allowedUses?.includes(lease.token);
  const ownMutation = (request, lease) => lease.kind === "mutation" && lease.owner === request.owner &&
    request.allowedMutations?.includes(lease.token);
  function scheduleOrphans() {
    if (orphanTimer || ![...active.values(), ...gameActivity.values()].some(lease => lease.orphan)) return;
    orphanTimer = setTimeout(async () => {
      orphanTimer = undefined;
      for (const [token, lease] of active) {
        if (!lease.orphan) continue;
        const alive = await Promise.all([...lease.pids].map(pid => Promise.resolve().then(() => isProcessAlive(pid)).catch(() => true)));
        if (!alive.some(Boolean) && active.get(token) === lease) active.delete(token);
      }
      for (const [token, lease] of gameActivity) {
        if (!lease.orphan) continue;
        const alive = await Promise.all([...lease.pids].map(pid => Promise.resolve().then(() => isProcessAlive(pid)).catch(() => true)));
        if (!alive.some(Boolean) && gameActivity.get(token) === lease) gameActivity.delete(token);
      }
      drain(); scheduleOrphans();
    }, orphanPollMs);
    orphanTimer.unref?.();
  }
  function drain() {
    for (let index = 0; index < pending.length;) {
      const request = pending[index];
      if (closedOwners.has(request.owner)) {
        pending.splice(index, 1); request.reject(coordinationError("RUNTIME_OWNER_CLOSED", "The backend operation was closed.")); continue;
      }
      const blockers = [...active.values()].filter(lease => overlap(request, lease));
      if (request.kind === "mutation" && blockers.some(lease => lease.kind === "use" && lease.pids.size > 0 && !ownPreparationUse(request, lease))) {
        pending.splice(index, 1);
        request.reject(coordinationError("RUNTIME_IN_USE", "Quit games using this runtime version before changing or removing it.")); continue;
      }
      const insideOwnMutation = blockers.some(lease => ownMutation(request, lease));
      const waits = blockers.some(lease => lease.kind === "mutation" && !ownMutation(request, lease)) ||
        (request.kind === "mutation" && blockers.some(lease => lease.kind === "use" && !ownPreparationUse(request, lease))) ||
        (!insideOwnMutation && pending.slice(0, index).some(earlier => overlap(request, earlier) && (request.kind === "mutation" || earlier.kind === "mutation")));
      if (waits) { index++; continue; }
      pending.splice(index, 1);
      const token = randomUUID();
      active.set(token, { ...request, token, pids: new Set() });
      request.resolve(token);
    }
  }
  function acquire(owner, kind, identities, allowedUses = [], allowedMutations = []) {
    const values = (Array.isArray(identities) ? identities : [identities]).map(runtimeIdentity);
    if (!values.length) throw new TypeError("A runtime lease needs an identity.");
    return new Promise((resolve, reject) => { pending.push({ owner, kind, identities: values, allowedUses, allowedMutations, resolve, reject }); drain(); });
  }
  function owned(owner, token) {
    const lease = active.get(token) || gameActivity.get(token);
    if (!lease || lease.owner !== owner) throw coordinationError("RUNTIME_LEASE_INVALID", "Runtime lease is unavailable for this operation.");
    return lease;
  }
  function release(owner, token) {
    const lease = active.get(token) || gameActivity.get(token);
    if (!lease) return false;
    owned(owner, token); active.delete(token); gameActivity.delete(token); drain(); return true;
  }
  function gameIdentity(value) {
    if (!value || !/^[0-9A-Za-z_-]+$/.test(value.gameId || "") || typeof value.gamePath !== "string" || !path.isAbsolute(value.gamePath)) {
      throw new TypeError("Game activity requires a game id and absolute path.");
    }
    return { gameId: value.gameId, gamePath: path.resolve(value.gamePath) };
  }
  function acquireGame(owner, kind, value) {
    const identity = gameIdentity(value);
    if (closedOwners.has(owner)) throw coordinationError("RUNTIME_OWNER_CLOSED", "The backend operation was closed.");
    const leases = [...gameActivity.values()].filter(lease => lease.gameId === identity.gameId);
    if (kind === "use" && removedGames.has(identity.gameId)) throw coordinationError("GAME_REMOVED", "This game was removed from the library. Add it again before using it.");
    if (kind === "remove" ? leases.length : leases.some(lease => lease.kind === "remove")) {
      throw coordinationError("GAME_IN_USE", kind === "remove"
        ? "Stop the game or wait for its current action to finish."
        : "Game removal is in progress. Try again when it finishes.");
    }
    const token = randomUUID();
    gameActivity.set(token, { ...identity, owner, kind, token, pids: new Set() });
    return token;
  }
  function closeOwner(owner) {
    closedOwners.add(owner);
    for (const [token, lease] of active) {
      if (lease.owner !== owner) continue;
      if (lease.kind === "use" && lease.pids.size) lease.orphan = true;
      else active.delete(token);
    }
    for (const [token, lease] of gameActivity) {
      if (lease.owner !== owner) continue;
      if (lease.kind === "use" && lease.pids.size) lease.orphan = true;
      else gameActivity.delete(token);
    }
    drain(); scheduleOrphans();
  }
  function applySettings(before, after) {
    if (!userDataDir) throw new Error("Settings transactions require userDataDir.");
    const file = path.join(userDataDir, "settings.json");
    // No await between fresh read, merge and atomic commit: one host is the writer.
    const current = readJsonObject(file) || {};
    const next = mergeSettingsChanges(before, after, current);
    writeJsonAtomic(file, next); return next;
  }
  function client(owner = randomUUID()) {
    return {
      acquireMutation: (identity, allowedUses) => acquire(owner, "mutation", identity, allowedUses),
      acquireUse: (identities, allowedMutations) => acquire(owner, "use", identities, [], allowedMutations),
      acquireGameUse: value => acquireGame(owner, "use", value),
      acquireGameRemoval: value => acquireGame(owner, "remove", value),
      completeGameRemoval: token => {
        const lease = owned(owner, token);
        if (gameActivity.get(token) !== lease || lease.kind !== "remove") throw coordinationError("RUNTIME_LEASE_INVALID", "Game removal is not owned by this operation.");
        removedGames.add(lease.gameId);
        release(owner, token);
        return true;
      },
      extendMutation: (token, identity, allowedUses = []) => {
        const lease = owned(owner, token), target = runtimeIdentity(identity);
        if (lease.kind !== "mutation" || lease.identities.length !== 1 || lease.identities[0].managerId !== target.managerId) {
          throw coordinationError("RUNTIME_LEASE_INVALID", "A mutation can only extend its own manager scope.");
        }
        const extended = { owner, identities: [target], allowedUses };
        const blockers = [...active.values()].filter(other => other !== lease && overlap(extended, other));
        if (blockers.some(other => other.kind === "use" && !ownPreparationUse(extended, other))) throw coordinationError("RUNTIME_IN_USE", "Quit games using this runtime before changing it.");
        if (blockers.some(other => other.kind === "mutation") || pending.some(request => overlap(extended, request) && !overlap(lease, request))) {
          // Never wait while holding a narrower mutation: two jobs upgrading in
          // opposite directions must fail cleanly instead of deadlocking.
          throw coordinationError("RUNTIME_MUTATION_BUSY", "Another runtime operation is changing this manager. Try again when it finishes.");
        }
        lease.identities = [target]; return true;
      },
      release: token => release(owner, token),
      bindUse: (token, pid) => {
        const lease = owned(owner, token);
        if (lease.kind !== "use" || !Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("Runtime use needs a valid process PID.");
        lease.pids.add(pid); drain(); return true;
      },
      applySettings,
      close: () => closeOwner(owner)
    };
  }
  return { client, snapshot: () => ({ active: [...active.values()].map(lease => ({ kind: lease.kind,
    identities: lease.identities, pids: [...lease.pids], orphan: Boolean(lease.orphan) })), pending: pending.length,
    games: [...gameActivity.values()].map(lease => ({ kind: lease.kind, gameId: lease.gameId,
      pids: [...lease.pids], orphan: Boolean(lease.orphan) })) }) };
}

const coordinators = new Map();
function coordinatorFor(userDataDir) {
  // Resolve an existing ancestor so a not-yet-created directory has the same
  // coordination key after installation, including macOS /var symlinks.
  let ancestor = path.resolve(userDataDir); const suffix = [];
  for (;;) {
    try { ancestor = fs.realpathSync(ancestor); break; }
    catch { const parent = path.dirname(ancestor); if (parent === ancestor) break; suffix.unshift(path.basename(ancestor)); ancestor = parent; }
  }
  const key = path.join(ancestor, ...suffix);
  if (!coordinators.has(key)) coordinators.set(key, createRuntimeCoordinator({ userDataDir: key }));
  return coordinators.get(key);
}
function remoteRuntimeCoordinator(callHost) {
  return Object.fromEntries(["acquireMutation", "extendMutation", "acquireUse", "acquireGameUse", "acquireGameRemoval", "completeGameRemoval", "release", "bindUse", "applySettings"].map(method =>
    [method, (...args) => callHost(`runtimeCoordinator.${method}`, ...args)]));
}

module.exports = { createRuntimeCoordinator, coordinatorFor, remoteRuntimeCoordinator, runtimeIdentity, conflicts, containsPath, coordinationError, isRuntimeProcessAlive };
