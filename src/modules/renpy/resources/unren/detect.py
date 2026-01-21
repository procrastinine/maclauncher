import os
import re
import sys
from pathlib import Path
from typing import Iterable, List, Optional


def normalize_path(arg: str) -> str:
    return arg.strip().strip("\"'")


def detect_renpy_version(base_dir: Path) -> Optional[int]:
    """Best-effort detection of major Ren'Py version from a game directory."""
    base_dir = base_dir.resolve()

    # Try importing renpy if available on sys.path.
    try:
        import renpy  # type: ignore

        try:
            return int(renpy.version_tuple[0])
        except Exception:
            pass
    except Exception:
        pass

    version_file = base_dir / "renpy" / "version.py"
    if not version_file.exists():
        return None

    try:
        txt = version_file.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None

    m = re.search(r"version_tuple\s*=\s*\(\s*(\d+)", txt)
    if m:
        return int(m.group(1))

    m = re.search(r"version\s*=\s*[\"'](\d+)\.", txt)
    if m:
        return int(m.group(1))

    return None


def try_renpy_handlers() -> Optional[List[str]]:
    try:
        import renpy.object  # type: ignore
        import renpy.loader  # type: ignore

        try:
            import renpy.config  # noqa: F401
            import renpy.error  # noqa: F401
        except Exception:
            pass

        handlers = getattr(renpy.loader, "archive_handlers", None)
        if handlers is None:
            return None

        handlers = getattr(handlers, "handlers", handlers)

        exts: List[str] = []
        for handler in handlers:
            if hasattr(handler, "get_supported_extensions"):
                exts.extend(handler.get_supported_extensions())
            elif hasattr(handler, "get_supported_ext"):
                exts.extend(handler.get_supported_ext())

        exts = sorted(set(e for e in exts if isinstance(e, (str, bytes))))
        return exts or None
    except Exception:
        return None


def is_rpa_file(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            sig = handle.read(8)
        return sig.startswith(b"RPA-")
    except Exception:
        return False


def scan_present_archives(base_dir: Path, recursive: bool = False) -> List[str]:
    exts = set()

    def scan(dir_path: Path) -> None:
        try:
            for entry in dir_path.iterdir():
                if not entry.is_file():
                    continue
                if is_rpa_file(entry):
                    ext = entry.suffix.lower()
                    if ext:
                        exts.add(ext)
        except Exception:
            pass

    if recursive:
        try:
            for entry in base_dir.rglob("*"):
                if not entry.is_file():
                    continue
                if is_rpa_file(entry):
                    ext = entry.suffix.lower()
                    if ext:
                        exts.add(ext)
        except Exception:
            pass
    else:
        scan(base_dir)
        game_sub = base_dir / "game"
        if game_sub.is_dir():
            scan(game_sub)

    return sorted(exts)


def detect_archive_extensions(base_dir: Path, *, recursive: bool = False) -> List[str]:
    exts = try_renpy_handlers()
    if exts:
        return [e.decode("utf-8") if isinstance(e, bytes) else e for e in exts]

    exts = scan_present_archives(base_dir, recursive=recursive)
    if exts:
        return exts

    return [".rpa"]


def iter_files(paths: Iterable[Path], recursive: bool) -> Iterable[Path]:
    for path in paths:
        if path.is_file():
            yield path
            continue
        if not path.is_dir():
            continue
        if recursive:
            for entry in path.rglob("*"):
                if entry.is_file():
                    yield entry
        else:
            for entry in path.iterdir():
                if entry.is_file():
                    yield entry
