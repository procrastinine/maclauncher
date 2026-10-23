#!/usr/bin/env python3
"""Preserve original Android paths on a case-sensitive developer filesystem.

The sparse image is build storage, never a runtime dependency. An existing tree
is moved one verified file at a time so migration does not duplicate its size.
Run with the project Python environment.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


def case_sensitive(root):
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".case-probe-", dir=root) as temporary:
        path = Path(temporary) / "CaseProbe"
        path.write_bytes(b"case")
        return not (path.parent / "caseprobe").exists()


def workspace_directory(root):
    return root.parent / ("." + root.name + ".case-sensitive-workspace")


def atomic_json(file, value):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, file)


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").digest()


def migrate_tree(source, target, temporary):
    """Resume safely after interruption; an original is removed only after copy."""
    links = {}
    files = 0
    copied = 0
    next_progress = 1 << 30

    def move(current, destination):
        nonlocal files, copied, next_progress
        info = current.lstat()
        if stat.S_ISDIR(info.st_mode):
            if destination.is_symlink():
                raise ValueError("Migration directory conflicts with a link: " + str(destination))
            destination.mkdir(exist_ok=True)
            for entry in sorted(current.iterdir()):
                move(entry, destination / entry.name)
            os.chmod(destination, stat.S_IMODE(info.st_mode))
            os.utime(destination, ns=(info.st_atime_ns, info.st_mtime_ns))
            current.rmdir()
            return
        if stat.S_ISLNK(info.st_mode):
            value = os.readlink(current)
            if os.path.lexists(destination):
                if not destination.is_symlink() or os.readlink(destination) != value:
                    raise ValueError("Migration link conflicts with existing data: " + str(destination))
            else:
                os.symlink(value, destination)
                shutil.copystat(current, destination, follow_symlinks=False)
        elif stat.S_ISREG(info.st_mode):
            key = (info.st_dev, info.st_ino)
            if os.path.lexists(destination):
                if not destination.is_file() or destination.is_symlink() or digest(current) != digest(destination):
                    raise ValueError("Migration file conflicts with existing data: " + str(destination))
            elif key in links:
                os.link(links[key], destination)
            else:
                staged = temporary / uuid.uuid4().hex
                original = hashlib.sha256()
                try:
                    with current.open("rb") as reader, staged.open("xb") as writer:
                        while block := reader.read(1 << 20):
                            writer.write(block)
                            original.update(block)
                        writer.flush()
                        os.fsync(writer.fileno())
                    if staged.stat().st_size != info.st_size or digest(staged) != original.digest():
                        raise OSError("Source migration copy differs: " + str(current))
                    shutil.copystat(current, staged, follow_symlinks=False)
                    os.replace(staged, destination)
                finally:
                    staged.unlink(missing_ok=True)
                copied += info.st_size
            if info.st_nlink > 1:
                links[key] = destination
        else:
            raise ValueError("Build workspace contains a non-file resource: " + str(current))
        after = current.lstat()
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise OSError("Source changed during migration: " + str(current))
        current.unlink()
        files += 1
        if copied >= next_progress:
            print(f"Android source workspace: migrated {copied >> 30} GiB, {files} files", file=sys.stderr, flush=True)
            next_progress = copied + (1 << 30)

    # The volume root contains filesystem metadata. Only source-owned paths are
    # merged, and the temporary copy directory has a separately recorded name.
    for entry in sorted(source.iterdir()):
        move(entry, target / entry.name)
    return {"files": files, "bytes": copied}


def image_mount(image):
    result = subprocess.run(["/usr/bin/hdiutil", "info", "-plist"], check=True, capture_output=True)
    for record in plistlib.loads(result.stdout).get("images", []):
        if Path(record.get("image-path", "")).resolve() == image.resolve():
            mounts = [Path(entity["mount-point"]) for entity in record.get("system-entities", []) if "mount-point" in entity]
            if len(mounts) != 1:
                raise ValueError("Build image must contain one mounted filesystem")
            return mounts[0].resolve()
    return None


def attach(image, root):
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/usr/bin/hdiutil", "attach", str(image), "-nobrowse", "-noautoopen", "-owners", "on", "-mountpoint", str(root)], check=True, stdout=sys.stderr)
    if image_mount(image) != root or not case_sensitive(root):
        raise ValueError("Android build image did not mount as a case-sensitive filesystem")


def prepare_workspace(root):
    root = Path(os.path.abspath(root))
    root = root.parent.resolve() / root.name
    if root.is_symlink():
        raise ValueError("Original build workspace must be a directory, not a symbolic link")
    directory = workspace_directory(root)
    if not directory.exists() and case_sensitive(root):
        return {"sourceRoot": str(root), "caseSensitive": True}
    if sys.platform != "darwin":
        raise ValueError("Original Android sources require a case-sensitive filesystem")
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = directory / "workspace.json"
        if record.exists():
            state = json.loads(record.read_text())
            if state["sourceRoot"] != str(root):
                raise ValueError("Build workspace storage belongs to another source root")
        else:
            state = {"schemaVersion": 1, "sourceRoot": str(root), "image": str(directory / "sources.sparsebundle"),
                     "transferDirectory": ".migration-" + uuid.uuid4().hex, "phase": "creating"}
            atomic_json(record, state)
        image = Path(state["image"])
        if not image.exists():
            # Sparse capacity follows the backing filesystem's capacity; it is
            # not allocated up front. Actual copies remain bounded by free disk.
            gibibyte = 1 << 30
            capacity = (shutil.disk_usage(directory).total + gibibyte - 1) // gibibyte
            subprocess.run(["/usr/bin/hdiutil", "create", "-size", str(capacity) + "g", "-type", "SPARSEBUNDLE",
                            "-fs", "Case-sensitive APFS", "-volname", "AndroidBuild", str(image)], check=True, stdout=sys.stderr)
        mounted = image_mount(image)
        if mounted == root:
            if not case_sensitive(root):
                raise ValueError("Mounted build filesystem is not case-sensitive")
            state["phase"] = "ready"
            atomic_json(record, state)
            return {**state, "caseSensitive": True, "record": str(record)}
        temporary_mount = directory / "migration-mount"
        if mounted is not None and mounted != temporary_mount:
            raise ValueError("Build workspace image is mounted at another location: " + str(mounted))
        if mounted is None:
            if state["phase"] == "ready" and (not root.exists() or not any(root.iterdir())):
                attach(image, root)
                return {**state, "caseSensitive": True, "record": str(record)}
            attach(image, temporary_mount)
        state["phase"] = "migrating"
        atomic_json(record, state)
        temporary = temporary_mount / state["transferDirectory"]
        if os.path.lexists(root / temporary.name):
            raise ValueError("Migration temporary directory conflicts with an original path")
        temporary.mkdir(exist_ok=True)
        # Only unfinished temporary files created under this recorded directory
        # can be discarded; originals have not been removed for those files.
        for file in temporary.iterdir():
            file.unlink()
        root.mkdir(parents=True, exist_ok=True)
        state["migration"] = migrate_tree(root, temporary_mount, temporary)
        temporary.rmdir()
        state["phase"] = "mounting"
        atomic_json(record, state)
        subprocess.run(["/usr/bin/hdiutil", "detach", str(temporary_mount)], check=True, stdout=sys.stderr)
        attach(image, root)
        state["phase"] = "ready"
        atomic_json(record, state)
        return {**state, "caseSensitive": True, "record": str(record)}


def restore_containing(file):
    path = Path(os.path.abspath(file))
    for root in (path, *path.parents):
        if (workspace_directory(root) / "workspace.json").is_file():
            return prepare_workspace(root)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--root", type=Path)
    group.add_argument("--containing", type=Path)
    args = parser.parse_args()
    result = prepare_workspace(args.root) if args.root else restore_containing(args.containing)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
