const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Python = require("./python");
const { throwIfAborted } = require("./download-utils");

// The included interpreter reads tar (xz, gzip, bzip2) and zip archives
// without Homebrew. Validate every member before writing, then publish links
// last so archive aliases cannot redirect subsequent extraction outside the
// empty installation staging directory.
const ARCHIVE = /\.(?:tar\.(?:xz|gz|bz2|zst)|t[gx]z|tar|zip)$/i;
const EXTRACT_SCRIPT = String.raw`
import os, sys, stat, tarfile, zipfile, posixpath, shutil
archive, destination = sys.argv[1:]
root = os.path.realpath(destination)
if os.path.islink(destination) or os.listdir(destination):
    raise ValueError("Runtime extraction requires an empty installation folder.")
def safe_name(value):
    if not value or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Invalid runtime archive path.")
    while value.startswith("./"): value = value[2:]
    value = value.rstrip("/")
    if not value or value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Runtime archive path escapes its installation.")
    return value
# Tar and zip members as (name, kind, size, mode, link, member).
def members_of(source):
    if isinstance(source, zipfile.ZipFile):
        for info in source.infolist():
            mode = info.external_attr >> 16
            kind = "dir" if info.is_dir() else "sym" if stat.S_ISLNK(mode) else "file" if not stat.S_IFMT(mode) or stat.S_ISREG(mode) else "other"
            link = source.read(info).decode("utf-8") if kind == "sym" else None
            yield info.filename, kind, info.file_size, (mode & 0o777) or 0o644, link, info
    else:
        for member in source:
            kind = "dir" if member.isdir() else "file" if member.isfile() else "sym" if member.issym() else "hard" if member.islnk() else "other"
            yield member.name, kind, member.size, member.mode & 0o777, member.linkname if kind in ("sym", "hard") else None, member
with (zipfile.ZipFile(archive) if zipfile.is_zipfile(archive) else tarfile.open(archive, "r:*")) as source:
    members, seen, aliases, total = [], set(), set(), 0
    for name, kind, size, mode, link, member in members_of(source):
        if kind == "dir" and name.rstrip("/") in (".", ""): continue
        name = safe_name(name)
        if name in seen: raise ValueError("Runtime archive contains duplicate paths.")
        seen.add(name)
        if kind == "other": raise ValueError("Runtime archive contains an unsupported file type.")
        if size < 0: raise ValueError("Invalid runtime archive member size.")
        total += size
        target = None
        if kind in ("sym", "hard"):
            if not link or link.startswith("/") or "\\" in link or any(ord(c) < 32 or ord(c) == 127 for c in link):
                raise ValueError("Runtime archive link escapes its installation.")
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link)) if kind == "sym" else safe_name(link)
            if target == ".." or target.startswith("../") or target.startswith("/"):
                raise ValueError("Runtime archive link escapes its installation.")
            aliases.add(name)
        members.append((name, kind, mode, link, target, member))
    for name, kind, mode, link, target, member in members:
        parts = name.split("/")
        if any("/".join(parts[:i]) in aliases for i in range(1, len(parts))):
            raise ValueError("Runtime archive writes through a symbolic link.")
        if kind == "hard" and target not in seen:
            raise ValueError("Runtime archive contains a missing hard-link target.")
        if kind == "hard" and target in aliases:
            raise ValueError("Runtime archive hard links cannot target another link.")
    for name, kind, mode, link, target, member in members:
        output = os.path.join(root, name)
        if kind == "dir": os.makedirs(output, exist_ok=True)
        elif kind == "file":
            os.makedirs(os.path.dirname(output), exist_ok=True)
            with (source.open(member) if isinstance(source, zipfile.ZipFile) else source.extractfile(member)) as data, open(output, "xb") as result:
                shutil.copyfileobj(data, result, 1024*1024)
            os.chmod(output, mode)
    for name, kind, mode, link, target, member in members:
        output = os.path.join(root, name)
        if kind in ("sym", "hard"):
            os.makedirs(os.path.dirname(output), exist_ok=True)
            if kind == "sym": os.symlink(link, output)
            else: os.link(os.path.join(root, target), output)
`;

async function extractArchive(archivePath, destination, signal, { spawn: start = spawn,
  resolvePython = () => Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot()) } = {}) {
  throwIfAborted(signal);
  if (!path.isAbsolute(archivePath) || !ARCHIVE.test(archivePath) || !path.isAbsolute(destination) ||
    !fs.lstatSync(archivePath).isFile() || fs.lstatSync(archivePath).isSymbolicLink() ||
    fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)
    throw new Error("Runtime extraction requires a runtime archive and an empty installation folder.");
  if (/\.tar\.zst$/i.test(archivePath)) {
    const expanded = path.join(path.dirname(destination), ".archive-" + require("node:crypto").randomUUID() + ".tar");
    try {
      await require("node:util").promisify(require("node:child_process").execFile)("/usr/bin/tar", ["-cf", expanded, "@" + archivePath], { signal });
      return await extractArchive(expanded, destination, signal, { spawn: start, resolvePython });
    } finally { fs.rmSync(expanded, { force: true }); }
  }
  const python = resolvePython();
  if (!python || !path.isAbsolute(python)) throw new Error("The included archive helper is missing. Reinstall MacLauncher.");
  await new Promise((resolve, reject) => {
    const child = start(python, ["-I", "-B", "-c", EXTRACT_SCRIPT, archivePath, destination],
      { ...(signal ? { signal } : {}), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", settled = false;
    const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    child.stderr.on("data", data => { if (stderr.length < 8192) stderr += data.toString().slice(0, 8192 - stderr.length); });
    child.once("error", finish);
    child.once("close", code => finish(code === 0 ? null : new Error(`Runtime archive extraction failed: ${stderr.trim() || code}`)));
  });
  throwIfAborted(signal);
}

module.exports = { ARCHIVE, extractArchive, EXTRACT_SCRIPT };
