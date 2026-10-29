const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Python = require("../../../shared/runtime/python");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");

// The included interpreter handles xz without Homebrew. Validate every member
// before writing, then publish links last so archive aliases cannot redirect
// subsequent extraction outside the empty installation staging directory.
const EXTRACT_SCRIPT = String.raw`
import os, sys, tarfile, posixpath, shutil
archive, destination = sys.argv[1:]
root = os.path.realpath(destination)
if os.path.islink(destination) or os.listdir(destination):
    raise ValueError("Runtime extraction requires an empty installation folder.")
def safe_name(value):
    if not value or len(value) > 4096 or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Invalid runtime archive path.")
    while value.startswith("./"): value = value[2:]
    value = value.rstrip("/")
    if not value or value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Runtime archive path escapes its installation.")
    return value
with tarfile.open(archive, "r:xz") as source:
    members, seen, aliases, total = [], set(), set(), 0
    for member in source:
        if len(members) >= 50000: raise ValueError("Runtime archive contains too many files.")
        name = safe_name(member.name)
        if name in seen: raise ValueError("Runtime archive contains duplicate paths.")
        seen.add(name)
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("Runtime archive contains an unsupported file type.")
        if member.size < 0 or member.size > 1024*1024*1024: raise ValueError("Runtime archive file exceeds its size limit.")
        total += member.size
        if total > 3*1024*1024*1024: raise ValueError("Runtime archive exceeds its unpacked size limit.")
        target = None
        if member.issym() or member.islnk():
            link = member.linkname
            if not link or len(link) > 4096 or link.startswith("/") or "\\" in link or any(ord(c) < 32 or ord(c) == 127 for c in link):
                raise ValueError("Runtime archive link escapes its installation.")
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link)) if member.issym() else safe_name(link)
            if target == ".." or target.startswith("../") or target.startswith("/"):
                raise ValueError("Runtime archive link escapes its installation.")
            aliases.add(name)
        members.append((member, name, target))
    for member, name, target in members:
        parts = name.split("/")
        if any("/".join(parts[:i]) in aliases for i in range(1, len(parts))):
            raise ValueError("Runtime archive writes through a symbolic link.")
        if member.islnk() and target not in seen:
            raise ValueError("Runtime archive contains a missing hard-link target.")
        if member.islnk() and target in aliases:
            raise ValueError("Runtime archive hard links cannot target another link.")
    for member, name, target in members:
        output = os.path.join(root, name)
        if member.isdir(): os.makedirs(output, exist_ok=True)
        elif member.isfile():
            os.makedirs(os.path.dirname(output), exist_ok=True)
            with source.extractfile(member) as data, open(output, "xb") as result:
                shutil.copyfileobj(data, result, 1024*1024)
            os.chmod(output, member.mode & 0o777)
    for member, name, target in members:
        output = os.path.join(root, name)
        if member.issym() or member.islnk():
            os.makedirs(os.path.dirname(output), exist_ok=True)
            if member.issym(): os.symlink(member.linkname, output)
            else: os.link(os.path.join(root, target), output)
`;

async function extractArchive(archivePath, destination, signal, { spawn: start = spawn,
  resolvePython = () => Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot()) } = {}) {
  throwIfAborted(signal);
  if (!path.isAbsolute(archivePath) || !archivePath.endsWith(".tar.xz") || !path.isAbsolute(destination) ||
    !fs.lstatSync(archivePath).isFile() || fs.lstatSync(archivePath).isSymbolicLink() ||
    fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)
    throw new Error("Sikarugir extraction requires a runtime archive and an empty installation folder.");
  const python = resolvePython();
  if (!python || !path.isAbsolute(python)) throw new Error("The included archive helper is missing. Reinstall MacLauncher.");
  await new Promise((resolve, reject) => {
    const child = start(python, ["-I", "-B", "-c", EXTRACT_SCRIPT, archivePath, destination],
      { ...(signal ? { signal } : {}), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", settled = false;
    const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    child.stderr.on("data", data => { if (stderr.length < 8192) stderr += data.toString().slice(0, 8192 - stderr.length); });
    child.once("error", finish);
    child.once("close", code => finish(code === 0 ? null : new Error(`Sikarugir archive extraction failed: ${stderr.trim() || code}`)));
  });
  throwIfAborted(signal);
}

module.exports = { extractArchive, EXTRACT_SCRIPT };
