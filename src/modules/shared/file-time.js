// A whole-second change time cannot distinguish same-sized writes on coarse
// filesystems. Such stamps need byte validation before a cached result is reused.
function hasFineChangeTime(stat) {
  if (typeof stat.ctimeNs === "bigint") return stat.ctimeNs % 1000000000n !== 0n;
  return Number.isFinite(stat.ctimeMs) && stat.ctimeMs % 1000 !== 0;
}

module.exports = { hasFineChangeTime };
