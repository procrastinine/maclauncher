from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence

from .detect import detect_archive_extensions, detect_renpy_version
from .rpa import extract_archives
from .rpyc import decompile_paths


def _parse_paths(values):
    return [Path(value).expanduser() for value in values]


def _parse_exts(values):
    exts = []
    for value in values:
        for part in value.split(","):
            part = part.strip()
            if not part:
                continue
            if not part.startswith("."):
                part = "." + part
            exts.append(part.lower())
    return exts


def _cmd_detect(args) -> int:
    base_dir = Path(args.path).expanduser()
    version = detect_renpy_version(base_dir)
    exts = detect_archive_extensions(base_dir, recursive=args.deep)
    print(f"Ren'Py major version: {version if version is not None else 'unknown'}")
    print(f"Archive extensions: {', '.join(exts)}")
    return 0


def _cmd_extract(args) -> int:
    paths = _parse_paths(args.paths)
    output_dir = Path(args.output).expanduser() if args.output else None
    base_dir = Path(args.base_dir).expanduser() if args.base_dir else None
    include_ext = _parse_exts(args.include_ext)
    exclude_ext = _parse_exts(args.exclude_ext)
    renpy_path = Path(args.renpy_path).expanduser() if args.renpy_path else None

    results = extract_archives(
        paths,
        output_dir=output_dir,
        base_dir=base_dir,
        recursive=args.recursive,
        mode=args.mode,
        include_ext=include_ext,
        exclude_ext=exclude_ext,
        use_runtime=args.runtime_fallback,
        renpy_path=renpy_path,
        remove=args.remove,
        move_to=Path(args.move_to).expanduser() if args.move_to else None,
        auto_retry=args.auto_retry,
        detect_all=args.detect_all,
    )

    for result in results:
        if result.state == "ok":
            print(f"{result.archive_path} -> {result.output_dir} ({result.extracted} files)")
        else:
            print(f"{result.archive_path} -> error: {result.error}")

    return 0 if all(r.state == "ok" for r in results) else 1


def _cmd_decompile(args) -> int:
    paths = _parse_paths(args.paths)
    output_dir = Path(args.output).expanduser() if args.output else None
    base_dir = Path(args.base_dir).expanduser() if args.base_dir else None
    renpy_path = Path(args.renpy_path).expanduser() if args.renpy_path else None

    results = decompile_paths(
        paths,
        output_dir=output_dir,
        base_dir=base_dir,
        recursive=args.recursive,
        overwrite=args.overwrite,
        try_harder=args.try_harder,
        dump=args.dump,
        init_offset=args.init_offset,
        mode=args.mode,
        profiles=args.profile,
        use_runtime=args.runtime_fallback,
        use_yvan=args.yvan,
        renpy_path=renpy_path,
        auto_retry=args.auto_retry,
        legacy_fallback=args.legacy_fallback,
    )

    for result in results:
        if result.state == "ok":
            print(f"{result.input_path} -> {result.output_path}")
        elif result.state == "skip":
            print(f"{result.input_path} -> skipped")
        else:
            print(f"{result.input_path} -> error: {result.error}")

    return 0 if all(r.state != "error" for r in results) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="unren")
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect = subparsers.add_parser("detect", help="Detect Ren'Py version and archive extensions.")
    detect.add_argument("path", nargs="?", default=".", help="Base directory to inspect.")
    detect.add_argument("--deep", action="store_true", help="Recursively scan for archives when Ren'Py handlers are unavailable.")
    detect.set_defaults(func=_cmd_detect)

    extract = subparsers.add_parser("extract", help="Extract RPA archives.")
    extract.add_argument("paths", nargs="+", help="Archive or directory paths.")
    extract.add_argument("-o", "--output", help="Output directory.")
    extract.add_argument("--base-dir", help="Base directory for relative output paths.")
    extract.add_argument("--mode", choices=["all", "code", "assets"], default="all")
    extract.add_argument("--include-ext", action="append", default=[], help="Include only extensions.")
    extract.add_argument("--exclude-ext", action="append", default=[], help="Exclude extensions.")
    extract.add_argument("--no-recursive", dest="recursive", action="store_false")
    extract.add_argument("--remove", action="store_true", help="Delete archives after extraction.")
    extract.add_argument("--move-to", help="Move archives to a directory after extraction.")
    extract.add_argument("--detect-all", action="store_true", help="Detect archives by signature, not just extension.")
    extract.add_argument("--runtime-fallback", action="store_true", help="Use Ren'Py runtime fallback.")
    extract.add_argument("--no-auto-retry", dest="auto_retry", action="store_false", help="Disable automatic retries.")
    extract.add_argument("--renpy-path", help="Path to add to sys.path for Ren'Py runtime.")
    extract.set_defaults(func=_cmd_extract, recursive=True, auto_retry=True, detect_all=False)

    decompile = subparsers.add_parser("decompile", help="Decompile RPYC/RPYMC files.")
    decompile.add_argument("paths", nargs="+", help="File or directory paths.")
    decompile.add_argument("-o", "--output", help="Output directory.")
    decompile.add_argument("--base-dir", help="Base directory for relative output paths.")
    decompile.add_argument("--no-recursive", dest="recursive", action="store_false")
    decompile.add_argument("--overwrite", action="store_true")
    decompile.add_argument("--try-harder", action="store_true")
    decompile.add_argument("--dump", action="store_true", help="Dump AST to text instead of rpy.")
    decompile.add_argument("--no-init-offset", dest="init_offset", action="store_false")
    decompile.add_argument("--mode", choices=["auto", "current", "legacy"], default="auto")
    decompile.add_argument("--profile", action="append", default=[], help="Profile override (repeat).")
    decompile.add_argument("--runtime-fallback", action="store_true", help="Use Ren'Py runtime fallback.")
    decompile.add_argument("--yvan", action="store_true", help="Try YVANeusEX decryption.")
    decompile.add_argument("--no-auto-retry", dest="auto_retry", action="store_false", help="Disable automatic retries.")
    decompile.add_argument("--no-legacy-fallback", dest="legacy_fallback", action="store_false", help="Disable legacy fallback in auto/current mode.")
    decompile.add_argument("--renpy-path", help="Path to add to sys.path for Ren'Py runtime.")
    decompile.set_defaults(func=_cmd_decompile, recursive=True, init_offset=True, auto_retry=True, legacy_fallback=True)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
