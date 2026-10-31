const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

// Apple's Developer ID designated-requirement form for one publisher team.
// codesign reads the signature statically; the checked file is not executed.
function requirement(teamIdentifier) {
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier || "")) throw new Error("A Developer ID team identifier is required.");
  return "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and " +
    `certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}
async function verifyDeveloperId(file, teamIdentifier, { execute = run, signal } = {}) {
  const args = ["--verify", "--strict", `-R=${requirement(teamIdentifier)}`, file];
  try {
    await execute("/usr/bin/codesign", args, { timeout: 30000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`The downloaded code is not validly signed by Developer ID team ${teamIdentifier}.`, { cause: error });
  }
  return { teamIdentifier };
}
module.exports = { requirement, verifyDeveloperId };
