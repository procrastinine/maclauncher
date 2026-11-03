// Parent links of running processes and the descendants of a process. A
// launched process often starts the app the user sees, such as a Wine
// supervisor shell and its wine child, so the launched PID alone does not
// identify that app.
const { execFile } = require("node:child_process");

const validPid = value => Number.isSafeInteger(value) && value > 0;

/** [pid, parent pid] rows parsed from `ps -axo pid=,ppid=` output. */
function parse(text) {
  return String(text || "").trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => validPid(pid) && Number.isSafeInteger(parent) && parent >= 0);
}

/** Every running process as [pid, parent pid]; empty when ps fails. */
function list({ execFile: run = execFile } = {}) {
  return new Promise(resolve => run("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout) => resolve(error ? [] : parse(stdout))));
}

/** The given processes and their descendants in `rows`, at most `limit` PIDs. */
function descendants(roots, rows, limit = 512) {
  const pids = new Set([].concat(roots).filter(validPid));
  for (let changed = pids.size > 0; changed && pids.size < limit;) {
    changed = false;
    for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid) && pids.size < limit) { pids.add(pid); changed = true; }
  }
  return pids;
}

module.exports = { parse, list, descendants };
