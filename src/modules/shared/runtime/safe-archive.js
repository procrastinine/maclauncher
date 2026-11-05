const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Python = require("./python");
const { throwIfAborted } = require("./download-utils");

// The included interpreter reads tar (xz, gzip, bzip2) and zip archives
// without Homebrew. Validate every member before writing, then publish links
// last so archive aliases cannot redirect subsequent extraction outside the
// empty installation staging directory.
const ARCHIVE = /\.(?:tar\.(?:xz|gz|bz2|zst)|t[gx]z|tar|zip|pkg)$/i;
const EXTRACT_SCRIPT = String.raw`
import os, sys, stat, tarfile, zipfile, posixpath, shutil, io, struct, zlib, gzip, bz2, lzma, tempfile, contextlib, hashlib
import xml.etree.ElementTree as XML
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
# A flat macOS package is a XAR of component payloads. Read only PackageInfo
# and Payload; scripts and distribution actions are never extracted or run.
# Install locations become ordinary relative paths below this staging root.
class PackageArchive:
    def __init__(self, filename):
        self.stack = contextlib.ExitStack()
        try: self.read(filename)
        except BaseException:
            self.stack.close(); raise
    def read(self, filename):
        self.source = self.stack.enter_context(open(filename, "rb"))
        self.size = os.fstat(self.source.fileno()).st_size
        header = self.exact(self.source, 28)
        magic, header_size, version, compressed, expanded, checksum = struct.unpack(">4sHHQQI", header)
        if magic != b"xar!" or version != 1 or header_size < 28 or header_size + compressed > self.size:
            raise ValueError("Invalid macOS package header.")
        self.source.seek(header_size)
        compressed_toc = self.exact(self.source, compressed)
        toc = zlib.decompress(compressed_toc)
        if len(toc) != expanded: raise ValueError("Invalid macOS package table size.")
        self.heap = header_size + compressed
        self.entries = {}
        def visit(parent, prefix=""):
            for node in parent.findall("file"):
                name = safe_name(posixpath.join(prefix, node.findtext("name", "")))
                if name in self.entries: raise ValueError("Duplicate macOS package entry.")
                self.entries[name] = node
                visit(node, name)
        toc_root = XML.fromstring(toc).find("toc")
        if toc_root is None: raise ValueError("Missing macOS package table.")
        declared = toc_root.find("checksum")
        if declared is not None:
            offset, size = int(declared.findtext("offset", "-1")), int(declared.findtext("size", "-1"))
            if min(offset, size) < 0 or self.heap + offset + size > self.size: raise ValueError("Invalid macOS package checksum range.")
            digest = self.digest(declared.get("style"))
            if digest:
                digest.update(compressed_toc); self.source.seek(self.heap + offset)
                if digest.digest() != self.exact(self.source, size): raise ValueError("Invalid macOS package table checksum.")
        visit(toc_root)
        self.members = []
        payloads = [name for name in self.entries if posixpath.basename(name) == "Payload"]
        if not payloads: raise ValueError("The macOS package has no component payloads.")
        for name in payloads:
            metadata = posixpath.join(posixpath.dirname(name), "PackageInfo")
            if metadata not in self.entries: raise ValueError("Missing component package information.")
            info = self.data(self.entries[metadata])
            location = XML.parse(info).getroot().get("install-location", "/")
            prefix = safe_name(location.lstrip("/")) if location.strip("/") else ""
            payload = self.data(self.entries[name]); magic = payload.read(6); payload.seek(0)
            cpio = self.stack.enter_context(tempfile.TemporaryFile(dir=os.path.dirname(root)))
            if magic[:4] == b"pbzx":
                payload.read(4); flags = struct.unpack(">Q", self.exact(payload, 8))[0]
                while flags & (1 << 24):
                    flags, length = struct.unpack(">QQ", self.exact(payload, 16))
                    chunk = self.exact(payload, length)
                    cpio.write(lzma.decompress(chunk) if chunk.startswith(b"\xfd7zXZ\x00") else chunk)
                if payload.read(1): raise ValueError("Unexpected macOS payload data.")
            elif magic[:2] == b"\x1f\x8b":
                with gzip.GzipFile(fileobj=payload) as stream: shutil.copyfileobj(stream, cpio)
            else: shutil.copyfileobj(payload, cpio)
            cpio.seek(0); self.read_cpio(cpio, prefix)
        # Installer resources can contain the supplied notices. Retain them
        # as data beside the extracted payloads, without distribution actions.
        for name, node in self.entries.items():
            if name.startswith("Resources/") and node.findtext("type") == "file":
                try:
                    content = self.data(node); content.seek(0, 2); size = content.tell(); content.seek(0)
                    self.members.append(["package-resources/" + name[len("Resources/"):], "file", size, 0o644, None, (content, 0, size)])
                except Exception as error: print("Skipped optional package resource " + name + ": " + str(error), file=sys.stderr)
    @staticmethod
    def exact(source, size):
        value = source.read(size)
        if len(value) != size: raise ValueError("Truncated macOS package data.")
        return value
    @staticmethod
    def digest(style):
        try: return hashlib.new(str(style).lower().replace("-", ""))
        except ValueError:
            print("Unrecognized optional package checksum: " + str(style), file=sys.stderr); return None
    def data(self, node):
        if node.findtext("type") != "file": raise ValueError("Invalid macOS component metadata type.")
        data = node.find("data")
        if data is None: raise ValueError("Missing macOS component data.")
        offset, length, size = [int(data.findtext(key, "-1")) for key in ("offset", "length", "size")]
        if min(offset, length, size) < 0 or self.heap + offset + length > self.size:
            raise ValueError("Invalid macOS component data range.")
        encoding = data.find("encoding")
        encoding = encoding.get("style", "application/octet-stream") if encoding is not None else "application/octet-stream"
        decoders = {"application/x-gzip": zlib.decompressobj, "application/x-bzip2": bz2.BZ2Decompressor,
                    "application/x-lzma": lzma.LZMADecompressor}
        if encoding != "application/octet-stream" and encoding not in decoders:
            raise ValueError("Unsupported macOS package compression.")
        decoder = decoders[encoding]() if encoding in decoders else None
        checks = [(data.find(tag), None) for tag in ("archived-checksum", "extracted-checksum")]
        checks = [(node, self.digest(node.get("style")) if node is not None else None) for node, _ in checks]
        output = self.stack.enter_context(tempfile.TemporaryFile(dir=os.path.dirname(root)))
        self.source.seek(self.heap + offset)
        remaining = length
        while remaining:
            chunk = self.exact(self.source, min(remaining, 1024*1024)); remaining -= len(chunk)
            decoded = decoder.decompress(chunk) if decoder else chunk
            if checks[0][1]: checks[0][1].update(chunk)
            if checks[1][1]: checks[1][1].update(decoded)
            output.write(decoded)
        if decoder and not decoder.eof: raise ValueError("Truncated macOS package compression.")
        if output.tell() != size: raise ValueError("Invalid macOS component size.")
        for declared, digest in checks:
            if digest and digest.hexdigest() != (declared.text or "").strip().lower(): raise ValueError("Invalid macOS component checksum.")
        output.seek(0); return output
    def read_cpio(self, source, prefix):
        links, entries = {}, []
        while True:
            magic = self.exact(source, 6)
            if magic == b"070707":
                fields = self.exact(source, 70)
                dev, ino, mode, uid, gid, nlink, rdev = [int(fields[i:i+6], 8) for i in range(0, 42, 6)]
                namesize, size = int(fields[53:59], 8), int(fields[59:70], 8)
                key, alignment = (dev, ino), 1
            elif magic in (b"070701", b"070702"):
                fields = self.exact(source, 104)
                values = [int(fields[i:i+8], 16) for i in range(0, 104, 8)]
                ino, mode, uid, gid, nlink, mtime, size, major, minor, rmajor, rminor, namesize, check = values
                key, alignment = (major, minor, ino), 4
            else: raise ValueError("Unsupported macOS package payload format.")
            if namesize < 1: raise ValueError("Missing macOS payload path.")
            name = self.exact(source, namesize)
            if name[-1:] != b"\x00" or b"\x00" in name[:-1]: raise ValueError("Invalid macOS payload path.")
            name = name[:-1].decode("utf-8")
            source.seek((-source.tell()) % alignment, 1)
            if name == "TRAILER!!!": break
            offset = source.tell(); source.seek(size, 1)
            if source.tell() > os.fstat(source.fileno()).st_size: raise ValueError("Truncated macOS payload member.")
            source.seek((-source.tell()) % alignment, 1)
            if magic == b"070702":
                after = source.tell(); source.seek(offset); remaining, checksum = size, 0
                while remaining:
                    chunk = self.exact(source, min(remaining, 1024*1024)); checksum += sum(chunk); remaining -= len(chunk)
                if checksum & 0xffffffff != check: raise ValueError("Invalid macOS payload checksum.")
                source.seek(after)
            if name in (".", "./"):
                if not stat.S_ISDIR(mode): raise ValueError("Invalid macOS payload root.")
                if not prefix: continue
                name = prefix
            else: name = posixpath.join(prefix, safe_name(name))
            kind = "dir" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) else "sym" if stat.S_ISLNK(mode) else "other"
            link = None
            if kind == "sym":
                after = source.tell(); source.seek(offset); link = self.exact(source, size).decode("utf-8"); source.seek(after)
            member = [name, kind, size, mode & 0o777, link, (source, offset, size)]
            entries.append(member)
            if kind == "file" and nlink > 1: links.setdefault(key, []).append(member)
        for group in links.values():
            target = next((member for member in group if member[2]), group[0])
            for member in group:
                if member is not target: member[1], member[4] = "hard", target[0]
        self.members.extend(entries)
    def __enter__(self): return self
    def __exit__(self, *args): self.stack.close()
    def open(self, member):
        source, offset, size = member
        source.seek(offset)
        # Files are copied one at a time; each view is bounded to its member.
        class Reader(io.RawIOBase):
            def __init__(self): self.remaining = size
            def readable(self): return True
            def readinto(self, output):
                value = source.read(min(len(output), self.remaining)); self.remaining -= len(value)
                output[:len(value)] = value; return len(value)
        return io.BufferedReader(Reader())
    def same_file(self, first, second):
        if first[2] != second[2] or first[3] != second[3]: return False
        # Separate component streams may share a single backing payload. Read
        # each range explicitly so neither file view changes the other's seek.
        left, loffset, size = first[5]; right, roffset, _ = second[5]
        position = 0
        while position < size:
            count = min(size-position, 1024*1024)
            left.seek(loffset+position); a = self.exact(left, count)
            right.seek(roffset+position); b = self.exact(right, count)
            if a != b: return False
            position += count
        return True
# Tar and zip members as (name, kind, size, mode, link, member).
def members_of(source):
    if isinstance(source, PackageArchive):
        yield from source.members
    elif isinstance(source, zipfile.ZipFile):
        for info in source.infolist():
            mode = info.external_attr >> 16
            kind = "dir" if info.is_dir() else "sym" if stat.S_ISLNK(mode) else "file" if not stat.S_IFMT(mode) or stat.S_ISREG(mode) else "other"
            link = source.read(info).decode("utf-8") if kind == "sym" else None
            yield info.filename, kind, info.file_size, (mode & 0o777) or 0o644, link, info
    else:
        for member in source:
            kind = "dir" if member.isdir() else "file" if member.isfile() else "sym" if member.issym() else "hard" if member.islnk() else "other"
            yield member.name, kind, member.size, member.mode & 0o777, member.linkname if kind in ("sym", "hard") else None, member
with (PackageArchive(archive) if archive.lower().endswith(".pkg") else zipfile.ZipFile(archive) if zipfile.is_zipfile(archive) else tarfile.open(archive, "r:*")) as source:
    members, seen, aliases, directories, previous, total = [], set(), set(), set(), {}, 0
    for name, kind, size, mode, link, member in members_of(source):
        if kind == "dir" and name.rstrip("/") in (".", ""): continue
        name = safe_name(name)
        if name in seen:
            if isinstance(source, PackageArchive) and kind == "dir" and name in directories: continue
            prior = previous.get(name)
            if isinstance(source, PackageArchive) and prior and kind == prior[1]:
                if kind == "file" and source.same_file(prior, [name, kind, size, mode, link, member]): continue
                if kind in ("sym", "hard") and link == prior[4]: continue
            raise ValueError("Runtime archive contains duplicate paths: " + name)
        seen.add(name)
        previous[name] = [name, kind, size, mode, link, member]
        if kind == "dir": directories.add(name)
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
            with (source.open(member) if isinstance(source, (zipfile.ZipFile, PackageArchive)) else source.extractfile(member)) as data, open(output, "xb") as result:
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
    child.once("close", code => {
      if (code === 0 && stderr.trim()) console.warn(stderr.trim());
      finish(code === 0 ? null : new Error(`Runtime archive extraction failed: ${stderr.trim() || code}`));
    });
  });
  throwIfAborted(signal);
}

module.exports = { ARCHIVE, extractArchive, EXTRACT_SCRIPT };
