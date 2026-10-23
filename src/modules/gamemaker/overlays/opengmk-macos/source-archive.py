#!/usr/bin/env python3
"""Create the OpenGMK corresponding-source archive with neutral ownership."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile


MAX_MEMBERS = 20000
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
ADDITIONS = {
    "./maclauncher-overlay/source-archive.py": "source-archive.py",
    "./maclauncher-overlay/SOURCE_ARCHIVE.md": "SOURCE_ARCHIVE.md",
}


def digest(file):
    file.seek(0)
    result = hashlib.sha256()
    while chunk := file.read(1024 * 1024):
        result.update(chunk)
    file.seek(0)
    return result.hexdigest()


def member_key(info):
    name = info.name
    if name == "." and info.isdir():
        return "."
    if name.startswith("./"):
        name = name[2:]
    if (not name or name.startswith("/") or "\\" in name or
            any(ord(character) < 32 for character in name) or
            any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError("Source archive contains an unsafe member path.")
    return name


def source_tar_view(source_file):
    # Sorting members must not repeatedly seek backwards through gzip data.
    # A temporary seekable TAR view keeps source reads linear in archive size.
    view = tempfile.TemporaryFile()
    try:
        total = 0
        with gzip.GzipFile(fileobj=source_file, mode="rb") as compressed:
            while chunk := compressed.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_EXPANDED_BYTES + MAX_MEMBERS * 4096 + 10240:
                    raise ValueError("Source archive exceeds its expanded TAR size limit.")
                view.write(chunk)
        view.seek(0)
        return view
    except BaseException:
        view.close()
        raise


def normalize_source_archive(input_path, output_path, expected_sha256=None):
    if expected_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("The input SHA-256 must contain 64 lowercase hexadecimal digits.")
    input_path, output_path = Path(input_path), Path(output_path)
    if input_path.is_symlink() or not input_path.is_file():
        raise ValueError("The input must be a regular source archive.")
    companion_root = Path(__file__).resolve().parent
    additions = {name: (companion_root / relative).read_bytes()
                 for name, relative in ADDITIONS.items()}
    created = False
    try:
        with input_path.open("rb") as source_file:
            before = os.fstat(source_file.fileno())
            input_sha256 = digest(source_file)
            if expected_sha256 is not None and input_sha256 != expected_sha256:
                raise ValueError("The input source archive SHA-256 differs from the selected identity.")
            with source_tar_view(source_file) as source_tar, tarfile.open(fileobj=source_tar, mode="r:") as source:
                members, names, expanded_bytes = {}, set(), 0
                for member in source:
                    key = member_key(member)
                    if key in names or not (member.isfile() or member.isdir()):
                        raise ValueError("Source archives require unique regular files and directories.")
                    if (member.mode < 0 or member.mode > 0o777 or member.size < 0 or
                            member.size > MAX_FILE_BYTES or member.isdir() and member.size):
                        raise ValueError("Source archive member exceeds the supported mode or size.")
                    names.add(key)
                    members[member.name] = member
                    expanded_bytes += member.size
                    if len(names) > MAX_MEMBERS or expanded_bytes > MAX_EXPANDED_BYTES:
                        raise ValueError("Source archive exceeds the supported member or size limit.")
                for name, content in additions.items():
                    existing = next((member for member in members.values()
                                     if member is not None and member_key(member) == name[2:]), None)
                    if existing is not None:
                        if (existing.name != name or not existing.isfile() or existing.mode != 0o644 or
                                source.extractfile(existing).read() != content):
                            raise ValueError("The archive creation recipe differs from its included source.")
                    else:
                        if len(members) >= MAX_MEMBERS or expanded_bytes + len(content) > MAX_EXPANDED_BYTES:
                            raise ValueError("Source archive exceeds the supported member or size limit.")
                        members[name] = None
                        expanded_bytes += len(content)
                # Exclusive creation preserves every existing output, including
                # an input selected as the output by mistake.
                with output_path.open("xb") as output:
                    created = True
                    os.fchmod(output.fileno(), 0o644)
                    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0,
                                       compresslevel=9) as compressed:
                        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                            for name in sorted(members):
                                original = members[name]
                                info = tarfile.TarInfo(name)
                                info.uid = info.gid = 0
                                info.uname = info.gname = ""
                                info.mtime = 0
                                info.mode = original.mode if original is not None else 0o644
                                info.type = original.type if original is not None else tarfile.REGTYPE
                                info.size = original.size if original is not None else len(additions[name])
                                if original is not None:
                                    archive.addfile(info, source.extractfile(original) if original.isfile() else None)
                                else:
                                    archive.addfile(info, io.BytesIO(additions[name]))
            after = os.fstat(source_file.fileno())
            if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or
                    digest(source_file) != input_sha256):
                raise ValueError("The input source archive changed during creation.")
        with output_path.open("rb") as output:
            return {"schemaVersion": 1, "archive": output_path.name,
                    "sha256": digest(output), "bytes": output_path.stat().st_size,
                    "inputSha256": input_sha256, "members": len(members),
                    "uid": 0, "gid": 0, "uname": "", "gname": "", "mtime": 0,
                    "gzipTimestamp": 0, "sourceContentsAndModesPreserved": True}
    except BaseException:
        if created:
            output_path.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Existing complete corresponding-source TAR.GZ")
    parser.add_argument("output", help="New output TAR.GZ; existing files are preserved")
    parser.add_argument("--expected-sha256", help="Exact input archive SHA-256")
    args = parser.parse_args()
    try:
        result = normalize_source_archive(args.input, args.output, args.expected_sha256)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f"Source archive creation failed: {error}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
