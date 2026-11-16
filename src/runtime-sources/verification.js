'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Upstream=require('../modules/shared/runtime/upstream');
const {throwIfAborted}=require('../modules/shared/runtime/download-utils');

function readChecksum(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim()) || /^([a-f0-9]{64})$/i.exec(line.trim());
    if (match && (!match[2] || match[2] === filename)) return match[1].toLowerCase();
  }
  return null;
}

async function verifySumsFile({ archiveSha256, checksum, filename, signal, label = "Runtime" }, dependencies = {}) {
  throwIfAborted(signal);
  if (!checksum?.url) throw new Error(`The ${label} release lists no checksum file. No runtime was installed.`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-checksum-")), target = path.join(directory, "checksum");
  let text;
  try {
    await (dependencies.download || Upstream.download)(Upstream.listedFile(checksum), target, { signal, headers: { "User-Agent": "maclauncher" } });
    if (fs.statSync(target).size > 64 * 1024) throw new Error("it is larger than a checksum file");
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`The ${label} checksum file could not be read (${error.message}). No runtime was installed.`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const listed = readChecksum(text, filename);
  if (!listed) throw new Error(`The ${label} checksum file names no SHA-256 for the archive. No runtime was installed.`);
  if (listed !== archiveSha256) throw new Error(`The ${label} archive does not match its published SHA-256. No runtime was installed.`);
  return { verified: true, archiveSha256, identity: `publisher-sha256-file:${listed}` };
}
module.exports={readChecksum,verifySumsFile};
