const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const { inside } = require("./detect");

const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// DOSBox has no separate save-root option: an explicit override selects a
// writable DOS drive. Ordinary Play never calls this adapter.
async function prepareOverride({ source, executable, drive, directory, context }) {
  let parent = drive;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, drive));
  if (inside(source, target) || inside(target, source)) throw new Error("DOS game data must be stored outside the original game folder.");
  Writable.assertOwnDirectory(drive, drive);
  const record = path.join(directory, "files.json");
  let previous = {};
  try { const value = JSON.parse(fs.readFileSync(record, "utf8")); if (value.source === source && value.drive === drive) previous = value.files || {}; } catch {}
  const files = Object.create(null), parents = new Set(); let completed = 0;
  async function visit(from, relative = "") {
    context.signal?.throwIfAborted();
    const real = fs.realpathSync(from);
    if (!inside(source, real) || parents.has(real)) throw new Error("DOS game files must stay inside the imported folder without circular aliases.");
    parents.add(real);
    try {
      for (const item of fs.readdirSync(from, { withFileTypes: true })) {
        context.signal?.throwIfAborted();
        if ([".DS_Store", ".git"].includes(item.name)) continue;
        const name = relative ? path.join(relative, item.name) : item.name, input = path.join(from, item.name), output = path.join(drive, name);
        if (!inside(source, fs.realpathSync(input))) throw new Error("DOS game files must stay inside the imported folder.");
        const stat = fs.statSync(input);
        if (stat.isDirectory()) { Writable.assertOwnDirectory(drive, output); await visit(input, name); }
        else if (stat.isFile()) {
          const old = previous[name], stamp = `${stat.size}:${stat.mtimeMs}`;
          let destination;
          try { destination = fs.lstatSync(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error("DOS game data contains an invalid file alias.");
          let hash = old?.sha256;
          if (!destination || !old || old.stamp !== stamp) {
            hash = digest(input);
            if (!destination || old && digest(output) === old.sha256) {
              Writable.atomicCopy(input, output, { root: drive });
              fs.chmodSync(output, stat.mode | 0o600);
            }
          }
          files[name] = { stamp, sha256: hash };
        } else throw new Error("DOS game inputs must be ordinary files and folders.");
        if (++completed % 128 === 0) { context.onProgress?.({ phase: "prepare", completed, label: "Starting game…" }); await new Promise(resolve => setImmediate(resolve)); }
      }
    } finally { parents.delete(real); }
  }
  await visit(source);
  Writable.atomicWrite(record, JSON.stringify({ source, drive, files }) + "\n", { root: directory });
  return { directory, drive, executable: path.join(drive, path.relative(source, executable)) };
}
module.exports = { prepareOverride };
