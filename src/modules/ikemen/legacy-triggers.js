const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../shared/runtime/local-native");

// Ikemen 1.0's MugenVersion trigger takes major/minor instead of the numeric
// form used by pre-release content. Only comparisons to the 1.0 boundary are
// converted: their meaning is exact and does not depend on minor-version scale.
function rewriteVersionComparisons(text, { zss = true } = {}) {
  let output = "", offset = 0, replacements = 0;
  while (offset < text.length) {
    const remaining = text.slice(offset);
    if (text[offset] === '"' || text[offset] === "'") {
      const quote = text[offset]; let end = offset + 1;
      while (end < text.length) { if (text[end] === "\\") end += 2; else if (text[end++] === quote) break; }
      output += text.slice(offset, end); offset = end; continue;
    }
    if (text[offset] === "#" || (!zss && text[offset] === ";") || remaining.startsWith("//")) {
      const end = text.indexOf("\n", offset); const next = end < 0 ? text.length : end;
      output += text.slice(offset, next); offset = next; continue;
    }
    if (remaining.startsWith("/*")) {
      const end = text.indexOf("*/", offset + 2), next = end < 0 ? text.length : end + 2;
      output += text.slice(offset, next); offset = next; continue;
    }
    const match = !/[\w$]/.test(text[offset - 1] || "") && /^mugenversion\b\s*(>=|<)\s*1\.0(?![\w.])/i.exec(remaining);
    if (match) {
      output += `mugenVersion(major) ${match[1]} 1`; offset += match[0].length; replacements++; continue;
    }
    output += text[offset++];
  }
  return { text: output, replacements };
}

function prepareLegacyTriggers(wrapper, install) {
  if (install.version !== "1.0.0" || install.upstreamRevision !== "81c6da71d689625e20db79586815b695da00dd6d") return [];
  const changes = []; let files = 0;
  function visit(directory, depth = 0) {
    if (depth > 32 || files > 20000) throw new Error("Ikemen script folders exceed the depth or file-count limit.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:zss|cns|cmd)$/i.test(entry.name)) {
        files++;
        const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        // Trigger keywords are ASCII; preserve every other byte, including
        // screenpacks with legacy encodings in comments and quoted strings.
        const input = fs.readFileSync(file).toString("latin1"), result = rewriteVersionComparisons(input, { zss: /\.zss$/i.test(entry.name) });
        if (!result.replacements) continue;
        const originalSha256 = Native.hashFile(file);
        // Replacing the link itself creates a private transformed script; the
        // imported source remains unchanged. Resource files retain their aliases.
        const temporary = file + `.maclauncher-${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, Buffer.from(result.text, "latin1"), { flag: "wx" });
        try { fs.renameSync(temporary, file); }
        finally { fs.rmSync(temporary, { force: true }); }
        changes.push({ file: path.relative(wrapper, file), replacements: result.replacements, originalSha256, preparedSha256: Native.hashFile(file) });
      }
    }
  }
  for (const name of ["data", "chars", "stages"]) if (fs.existsSync(path.join(wrapper, name))) visit(path.join(wrapper, name));
  return changes;
}

module.exports = { rewriteVersionComparisons, prepareLegacyTriggers };
