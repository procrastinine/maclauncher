// File facts that survive a volume reconnect. Device numbers and ctime are
// mount/metadata details, not a change to the selected file's contents.
function signature(stat) {
  return `${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}:${stat.ino}`;
}

function normalize(value) {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(":") : [];
  if (parts.length === 3) return parts.join(":");
  // Earlier records stored dev:ino:size:mtime:ctime.
  if (parts.length === 5) return `${parts[2]}:${parts[3]}:${parts[1]}`;
  return null;
}

function same(before, after) {
  const value = normalize(before);
  return value !== null && value === normalize(after);
}

module.exports = { signature, normalize, same };
