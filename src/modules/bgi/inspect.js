const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Archive = require("./archive");
const { readPeVersion } = require("../shared/runtime/pe-version");

function engineVersionEvidence(metadata) {
  const identity = `${metadata?.strings?.ProductName || ""} ${metadata?.strings?.FileDescription || ""}`;
  const identified = /\b(?:BURIKO\s+General\s+Interpreter|Ethornell|BGI)\b/i.test(identity);
  const version = identified && /^\d+\.\d+\.\d+\.\d+$/.test(metadata?.fileVersion || "") && metadata.fileVersion !== "0.0.0.0"
    ? metadata.fileVersion : null;
  const compatibility = identified ? metadata?.strings?.FileVersion?.match(/\bCompatibility\s*:\s*(\d+\.\d+(?:\.\d+){0,2})(?=$|\s)/i)?.[1] || null : null;
  return { version, compatibility, source: version ? metadata.source : null };
}

function inspectGame(rootDir, { inputPath, detection } = {}) {
  try {
    const entries = detection?.readdir ? detection.readdir(rootDir) : fs.readdirSync(rootDir, { withFileTypes: true });
    const bootFile = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "system.arc");
    if (!bootFile) return null;
    const bootArchive = Archive.inspectArchive(path.join(rootDir, bootFile.name), { detection }), member = bootArchive.members.get("ipl._bp");
    if (!member) return null;
    const bytes = Archive.readMember(bootArchive, member, { maximumBytes: 256 * 1024, maximumOutput: 1024 * 1024, detection });
    const boot = Archive.inspectProgram(bytes);
    const runner = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "bgi.exe") ||
      entries.find(entry => entry.isFile() && path.join(rootDir, entry.name) === inputPath && /\.exe$/i.test(entry.name));
    const runnerPath = runner && path.join(rootDir, runner.name);
    const originalRunner = runnerPath ? readPeVersion(runnerPath, { detection }) : null;
    const version = engineVersionEvidence(originalRunner);
    return { title: path.basename(rootDir), bootArchivePath: bootArchive.file, bootScript: member.name, boot,
      archiveFormat: bootArchive.format, originalRunnerPath: runnerPath || null, originalRunner,
      detectedVersion: version.version || "unknown", detectedVersionConfidence: version.version ? "exact" : "unknown",
      detectedVersionSource: version.version ? `${version.source}; identified original BGI executable fixed version` : "Buriko program header; original engine version unknown",
      declaredCompatibilityVersion: version.compatibility,
      runtimeSourceVersion: "OpenBGI 0.0.1 Build734",
      compatibility: "Native gameplay is not yet supported by this OpenBGI profile." };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}

function inspectPrograms(rootDir) {
  const records = [], archives = [], skippedArchives = [], entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.arc$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > 128) throw new Error("Too many BGI archives for bounded program inspection.");
  let scriptBytes = 0, indexBytes = 0;
  for (const entry of entries) {
    let archive;
    // Unrelated asset archives may use another format or ambiguous filenames.
    // Keep their failure visible without weakening the strict export index.
    if (indexBytes >= 16 * 1024 * 1024) throw new Error("BGI archive indexes exceed their aggregate inspection limit.");
    try { archive = Archive.inspectArchive(path.join(rootDir, entry.name), { maximumIndexBytes: Math.min(Archive.LIMITS.indexBytes, 16 * 1024 * 1024 - indexBytes) }); }
    catch (error) { indexBytes += error.archiveBytesRead || 0; skippedArchives.push({ archive: entry.name, reason: error.message }); continue; }
    indexBytes += archive.bytesRead;
    const programs = [...archive.members.values()].filter(member => /\._bp$/i.test(member.name));
    if (!programs.length) continue;
    archives.push({ file: archive.file, format: archive.format, members: archive.members.size });
    for (const member of programs) {
      if (records.length >= 1024) throw new Error("Too many Buriko programs for bounded inspection.");
      const bytes = Archive.readMember(archive, member); scriptBytes += bytes.length;
      if (scriptBytes > 32 * 1024 * 1024) throw new Error("Buriko programs exceed their aggregate inspection limit.");
      records.push({ archive: path.basename(archive.file), filename: member.name, storedBytes: member.size, decodedBytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...Archive.inspectProgram(bytes) });
    }
  }
  return { archives, programs: records, skippedArchives, scannedArchives: entries.length, complete: skippedArchives.length === 0,
    programCount: records.length, scriptBytes, indexBytes,
    sourceRevision: "e2500e0badd04aab472e4620477747973e5e5544", runtimeVersion: "OpenBGI 0.0.1 Build734" };
}

module.exports = { engineVersionEvidence, inspectGame, inspectPrograms };
