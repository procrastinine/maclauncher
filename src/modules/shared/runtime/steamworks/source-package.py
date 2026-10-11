#!/usr/bin/env python3
"""Developer-only deterministic corresponding-source packaging (stdlib only).

The archive revision is independent of the native runtime/ABI version. Existing
source files retain their bytes; generated Python caches never become sources.
No archive is extracted into caller directories and existing outputs are kept.
"""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import re
import stat
import tarfile
import tempfile

VERSION = "maclauncher-corresponding-source-package-v2"
LIMITS = {"files": 20000, "file_bytes": 256 * 1024 * 1024,
          "bytes": 1024 * 1024 * 1024, "metadata_bytes": 64 * 1024}
SHA = re.compile(r"^[a-f0-9]{64}$")
PRIVATE_BUILD = re.compile(
    rb"/(?:Users|home)/[^/\s\x00\"'<>`]{1,100}/"
    rb"(?:[^/\s\x00\"'<>`]{1,100}/){0,8}"
    rb"maclauncher(?:-[^/\s\x00\"'<>`]{1,100})?/\.local/",
    re.IGNORECASE)
PRIVATE_TEMP = re.compile(
    rb"/(?:private/)?(?:tmp|var/folders/[^/\s\x00]+/[^/\s\x00]+/[^/\s\x00]+)/"
    rb"maclauncher-(?:frozen-candidate|java-agent|runtime-build|steamworks)[^\s\x00\"']*",
    re.IGNORECASE)


def safe_name(name):
    if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 1024:
        raise ValueError("Source archive has an invalid member name.")
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if (not name or name.startswith("/") or "\\" in name
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in name)
            or any(part in ("", ".", "..", ".local") for part in name.split("/"))):
        raise ValueError("Source archive has an unsafe member name.")
    return name


def generated_cache(name):
    return "__pycache__" in name.split("/") or name.lower().endswith((".pyc", ".pyo"))


def repository_metadata(name):
    return ".git" in name.split("/")


def digest_file(file):
    result = hashlib.sha256()
    with open(file, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def identity(file):
    value = os.fstat(file.fileno())
    if not stat.S_ISREG(value.st_mode):
        raise ValueError("Source archive input must be a regular file.")
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns)


class SourcePackageError(Exception):
    """A release-policy error that tarfile must not reinterpret as a header EOF."""


class BoundedInfo(tarfile.TarInfo):
    @classmethod
    def checked(cls, info):
        metadata = info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME)
        if info.size < 0 or info.size > (LIMITS["metadata_bytes"] if metadata else LIMITS["file_bytes"]):
            raise SourcePackageError("Source archive member exceeds its size limit.")
        if not metadata and info.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
            raise SourcePackageError("Source archives may contain only regular files and directories.")
        return info

    @classmethod
    def frombuf(cls, buf, encoding, errors):
        return cls.checked(super().frombuf(buf, encoding, errors))

    @classmethod
    def _frombuf(cls, buf, encoding, errors, *, dircheck=True):
        # Python 3.14's internal archive reader bypasses the public frombuf.
        # Validate its header before _proc_pax can allocate a metadata payload.
        read = getattr(super(), "_frombuf", None)
        info = (read(buf, encoding, errors, dircheck=dircheck) if read is not None
                else super().frombuf(buf, encoding, errors))
        return cls.checked(info)


def context_records(file, archive_sha256):
    if file is None:
        return {}
    if pathlib.Path(file).stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Source context inventory exceeds its size limit.")
    value = json.loads(pathlib.Path(file).read_text(encoding="utf-8"))
    if value.get("archiveSha256") != archive_sha256 or not isinstance(value.get("records"), list):
        raise ValueError("Source context inventory does not match this input archive.")
    result = {}
    for row in value["records"]:
        name = safe_name(row.get("member"))
        if (name in result or generated_cache(name) or repository_metadata(name)
                or not SHA.fullmatch(row.get("sha256", ""))
                or row.get("kind") not in ("upstream_fixture", "documented_example", "parser_marker")):
            raise ValueError("Source context inventory has an invalid or duplicate record.")
        result[name] = row
    if len(result) > LIMITS["files"]:
        raise ValueError("Source context inventory exceeds its file limit.")
    return result


def private_content(data, private_prefixes):
    # Four UTF-16 alignments cover embedded paths without assuming a file BOM.
    views = [data]
    for encoding in ("utf-16le", "utf-16be"):
        for offset in (0, 1):
            views.append(data[offset:].decode(encoding, errors="ignore").encode("utf-8"))
    return any(PRIVATE_BUILD.search(view) or PRIVATE_TEMP.search(view)
               or any(prefix in view for prefix in private_prefixes) for view in views)


def repack(input_archive, expected_sha256, output_archive, context_file=None,
           additions=None, private_prefixes=None):
    input_archive = pathlib.Path(input_archive)
    output_archive = pathlib.Path(output_archive)
    if (not input_archive.is_absolute() or not output_archive.is_absolute()
            or not SHA.fullmatch(expected_sha256 or "")
            or input_archive.resolve() == output_archive.resolve()):
        raise ValueError("Pass distinct absolute archive paths and an exact input SHA-256.")
    if output_archive.exists() or output_archive.is_symlink():
        raise ValueError("Source package output already exists; it was preserved.")
    if not output_archive.parent.is_dir() or output_archive.parent.is_symlink():
        raise ValueError("Source package output requires an existing real parent directory.")
    additions = additions or {}
    names = set()
    removed = []
    removed_repository_metadata = []
    records = []
    total = 0
    prefixes = [str(pathlib.Path.home()).encode("utf-8") + b"/"]
    prefixes.extend(value.encode("utf-8") for value in (private_prefixes or []))
    prefix_limit = max([8192] + [len(value) * 2 + 512 for value in prefixes])
    if prefix_limit > 64 * 1024:
        raise ValueError("Private-path prefixes exceed their limit.")
    source_fd = os.open(input_archive, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(source_fd, "rb") as source, tempfile.TemporaryDirectory(prefix="corresponding-source-") as storage:
        before = identity(source)
        if before[2] > LIMITS["file_bytes"]:
            raise ValueError("Compressed source input exceeds its size limit.")
        input_hash = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            input_hash.update(chunk)
        if input_hash.hexdigest() != expected_sha256:
            raise ValueError("Pinned corresponding-source archive changed.")
        source.seek(0)
        context = context_records(context_file, expected_sha256)

        def stage(name, stream, size, mode):
            nonlocal total
            name = safe_name(name)
            if name in names:
                raise ValueError("Source archive has duplicate member names.")
            names.add(name)
            if len(names) > LIMITS["files"] or size < 0 or size > LIMITS["file_bytes"]:
                raise ValueError("Source archive exceeds its member limits.")
            total += size
            if total > LIMITS["bytes"]:
                raise ValueError("Uncompressed source archive exceeds its size limit.")
            if generated_cache(name):
                removed.append(name)
                return
            if repository_metadata(name):
                removed_repository_metadata.append(name)
                return
            staged = pathlib.Path(storage) / str(len(records))
            result = hashlib.sha256()
            remaining = size
            overlap = b""
            with staged.open("xb") as target:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Source archive member is truncated.")
                    remaining -= len(chunk)
                    combined = overlap + chunk
                    if private_content(combined, prefixes):
                        raise ValueError("Source archive retains a private build path: " + name)
                    overlap = combined[-prefix_limit:]
                    result.update(chunk)
                    target.write(chunk)
            sha256 = result.hexdigest()
            if name in context and context[name]["sha256"] != sha256:
                raise ValueError("Reviewed upstream source context changed: " + name)
            records.append({"name": name, "file": staged, "size": size,
                            "mode": 0o755 if mode & 0o111 else 0o644, "sha256": sha256})

        with tarfile.open(fileobj=source, mode="r:gz", tarinfo=BoundedInfo) as archive:
            member_count = 0
            for member in archive:
                member_count += 1
                if member_count > LIMITS["files"] * 2:
                    raise ValueError("Source archive exceeds its metadata/member limit.")
                name = safe_name(member.name)
                if member.isdir():
                    continue
                stage(name, archive.extractfile(member), member.size, member.mode)
        if identity(source) != before:
            raise ValueError("Source archive input changed while packaging.")
        if not set(context).issubset(names):
            raise ValueError("Reviewed source context members are missing.")
        if not records:
            raise ValueError("A source package must retain at least one source file.")
        original_records = len(records)
        for name in sorted(additions):
            file = pathlib.Path(additions[name])
            fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as added:
                original = identity(added)
                stage(name, added, original[2], os.fstat(added.fileno()).st_mode)
                if identity(added) != original:
                    raise ValueError("Source package addition changed while packaging.")
        created = False
        try:
            fd = os.open(output_archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            created = True
            with os.fdopen(fd, "wb") as target:
                with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0, compresslevel=9) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                        for row in sorted(records, key=lambda value: value["name"]):
                            info = tarfile.TarInfo(row["name"])
                            info.type = tarfile.REGTYPE
                            info.size, info.mode = row["size"], row["mode"]
                            info.uid = info.gid = 0
                            info.uname = info.gname = ""
                            info.mtime = 0
                            with row["file"].open("rb") as data:
                                archive.addfile(info, data)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(output_archive, 0o644)
        except Exception:
            if created:
                output_archive.unlink(missing_ok=True)
            raise
    ledger = [{"member": row["name"], "size": row["size"], "mode": row["mode"], "sha256": row["sha256"]}
              for row in sorted(records, key=lambda value: value["name"])]
    return {"producerVersion": VERSION, "inputArchiveSha256": expected_sha256,
            "sha256": digest_file(output_archive), "size": output_archive.stat().st_size,
            "retainedInputFiles": original_records, "files": len(ledger),
            "removedGeneratedCaches": sorted(removed), "reviewedContextFiles": len(context),
            "removedRepositoryMetadata": sorted(removed_repository_metadata),
            "neutralUidGidNamesAndEpoch": True, "gzipTimestamp": 0,
            "privatePathScanComplete": True, "contentLedger": ledger}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--context")
    parser.add_argument("--add", action="append", default=[], metavar="MEMBER=FILE")
    parser.add_argument("--private-prefix", action="append", default=[])
    options = parser.parse_args()
    additions = {}
    for pair in options.add:
        name, separator, file = pair.partition("=")
        if not separator or name in additions:
            parser.error("Each addition must select a unique MEMBER=FILE.")
        additions[name] = file
    result = repack(options.input, options.sha256, options.output,
                    context_file=options.context, additions=additions,
                    private_prefixes=options.private_prefix)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (SourcePackageError, ValueError, OSError, tarfile.TarError) as error:
        raise SystemExit(str(error))
