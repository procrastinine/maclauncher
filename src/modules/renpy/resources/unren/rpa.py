from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from .detect import detect_archive_extensions, is_rpa_file, iter_files
from .vendor import import_rpatool


CODE_EXTENSIONS = {
    ".rpy",
    ".rpyc",
    ".rpym",
    ".rpymc",
    ".rpyb",
}


@dataclass
class ExtractResult:
    archive_path: Path
    output_dir: Path
    extracted: int
    state: str
    error: Optional[BaseException] = None


def _should_extract(name: str, mode: str, include_ext: Sequence[str], exclude_ext: Sequence[str]) -> bool:
    ext = Path(name).suffix.lower()
    if include_ext:
        return ext in include_ext
    if exclude_ext and ext in exclude_ext:
        return False
    if mode == "code":
        return ext in CODE_EXTENSIONS
    if mode == "assets":
        return ext not in CODE_EXTENSIONS
    return True


def _iter_archives(
    paths: Iterable[Path],
    recursive: bool,
    extensions: Sequence[str],
    detect_all: bool,
) -> Iterable[Path]:
    ext_set = {ext.lower() for ext in extensions}
    for path in iter_files(paths, recursive):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext in ext_set:
            yield path
            continue
        if detect_all and is_rpa_file(path):
            yield path


def _extract_with_rpatool(archive_path: Path, output_dir: Path, mode: str,
                          include_ext: Sequence[str], exclude_ext: Sequence[str]) -> int:
    rpatool = import_rpatool()
    archive = rpatool.RenPyArchive(str(archive_path))
    extracted = 0

    for filename in archive.list():
        if not _should_extract(filename, mode, include_ext, exclude_ext):
            continue
        contents = archive.read(filename)
        if contents is None:
            continue
        out_path = output_dir / filename
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("wb") as handle:
            handle.write(contents)
        extracted += 1

    return extracted


def _extract_with_runtime(archive_path: Path, output_dir: Path, mode: str,
                          include_ext: Sequence[str], exclude_ext: Sequence[str]) -> int:
    try:
        import renpy  # type: ignore
        import renpy.config  # type: ignore
        import renpy.loader  # type: ignore
    except Exception as exc:
        raise RuntimeError("Ren'Py runtime not available for fallback") from exc

    base = archive_path.stem
    if base not in renpy.config.archives:
        renpy.config.archives.append(base)

    archive_dir = archive_path.parent
    renpy.config.searchpath = [str(archive_dir)]
    renpy.config.basedir = str(archive_dir.parent)
    renpy.loader.index_archives()

    archives_obj = renpy.loader.archives
    if isinstance(archives_obj, dict):
        items = archives_obj[base][1].items()
    else:
        items = None
        for name, data in archives_obj:
            if name == base:
                items = data.items()
                break
        if items is None:
            raise RuntimeError("Ren'Py runtime did not index the archive")

    extracted = 0
    for filename, index in items:
        if not _should_extract(filename, mode, include_ext, exclude_ext):
            continue
        if hasattr(renpy.loader, "load_from_archive"):
            subfile = renpy.loader.load_from_archive(filename)
        else:
            subfile = renpy.loader.load_core(filename)
        contents = subfile.read()
        if contents is None:
            continue
        out_path = output_dir / filename
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("wb") as handle:
            handle.write(contents)
        extracted += 1

    return extracted


def extract_archives(
    paths: Iterable[Path],
    *,
    output_dir: Optional[Path] = None,
    base_dir: Optional[Path] = None,
    recursive: bool = True,
    mode: str = "all",
    include_ext: Optional[Sequence[str]] = None,
    exclude_ext: Optional[Sequence[str]] = None,
    use_runtime: bool = False,
    renpy_path: Optional[Path] = None,
    remove: bool = False,
    move_to: Optional[Path] = None,
    auto_retry: bool = True,
    detect_all: bool = False,
) -> List[ExtractResult]:
    if renpy_path is not None:
        sys.path.insert(0, str(renpy_path))

    extensions = detect_archive_extensions(
        base_dir or Path.cwd(),
        recursive=detect_all and recursive,
    )
    include_ext = [ext.lower() for ext in (include_ext or [])]
    exclude_ext = [ext.lower() for ext in (exclude_ext or [])]

    results: List[ExtractResult] = []
    for archive_path in _iter_archives(paths, recursive, extensions, detect_all):
        out_dir = output_dir or archive_path.parent
        if base_dir is not None:
            try:
                relative = archive_path.parent.relative_to(base_dir)
                out_dir = (output_dir or base_dir) / relative
            except ValueError:
                pass

        is_rpa = is_rpa_file(archive_path)
        methods: List[str]
        if use_runtime:
            if is_rpa:
                methods = ["rpatool", "runtime"]
            else:
                methods = ["runtime"]
                if auto_retry:
                    methods.append("rpatool")
        else:
            methods = ["rpatool"]

        extracted = 0
        last_exc: Optional[BaseException] = None
        for method in methods:
            try:
                if method == "runtime":
                    extracted = _extract_with_runtime(
                        archive_path, out_dir, mode, include_ext, exclude_ext
                    )
                else:
                    extracted = _extract_with_rpatool(
                        archive_path, out_dir, mode, include_ext, exclude_ext
                    )
                last_exc = None
                break
            except BaseException as exc:
                last_exc = exc

        if last_exc is not None:
            results.append(ExtractResult(archive_path, out_dir, 0, "error", error=last_exc))
            continue

        if move_to is not None:
            move_to.mkdir(parents=True, exist_ok=True)
            try:
                archive_path.replace(move_to / archive_path.name)
            except Exception:
                pass
        elif remove:
            try:
                archive_path.unlink()
            except Exception:
                pass

        results.append(ExtractResult(archive_path, out_dir, extracted, "ok"))

    return results
