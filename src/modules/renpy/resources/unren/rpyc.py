from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Sequence
import sys

from .detect import iter_files
from .patches import apply_deobfuscate_patches, build_decompiler_class, extend_class_factory
from .profiles import DecompilerProfile, resolve_profiles
from .vendor import (
    import_gideon_decompiler,
    import_unrpyc,
    import_unrpyc_decompiler,
    import_unrpyc_deobfuscate,
    import_unrpyc_renpycompat,
)


@dataclass
class DecompileResult:
    input_path: Path
    output_path: Optional[Path]
    state: str
    error: Optional[BaseException] = None
    log: List[str] = field(default_factory=list)


class Context:
    def __init__(self) -> None:
        self.log_contents: List[str] = []
        self.error: Optional[BaseException] = None
        self.state = "error"

    def log(self, message: str) -> None:
        self.log_contents.append(message)

    def set_error(self, error: BaseException) -> None:
        self.error = error

    def set_state(self, state: str) -> None:
        self.state = state


def _output_path(
    input_path: Path,
    output_dir: Optional[Path],
    base_dir: Optional[Path],
    dump: bool,
) -> Path:
    if dump:
        new_ext = ".txt"
    elif input_path.suffix.lower() == ".rpymc":
        new_ext = ".rpym"
    else:
        new_ext = ".rpy"

    if output_dir is None:
        return input_path.with_suffix(new_ext)

    if base_dir is not None:
        try:
            relative = input_path.relative_to(base_dir)
        except ValueError:
            relative = input_path.name
    else:
        relative = input_path.name

    return (output_dir / relative).with_suffix(new_ext)


def _safe_loads_from_blob(blob: bytes):
    renpycompat = import_unrpyc_renpycompat()
    try:
        return renpycompat.pickle_safe_loads(blob)
    except Exception:
        try:
            return renpycompat.pickle_safe_loads(zlib.decompress(blob))
        except Exception:
            raise


def _read_ast_from_runtime(in_file, context: Context):
    try:
        import renpy  # type: ignore
        from renpy import script  # type: ignore
    except Exception as exc:
        context.set_error(exc)
        raise

    if not hasattr(script.Script, "read_rpyc_data"):
        raise RuntimeError("renpy.script.Script.read_rpyc_data not available")

    raw_contents = script.Script.read_rpyc_data(object, in_file, 1)
    if isinstance(raw_contents, tuple) and len(raw_contents) == 2:
        return raw_contents[1]
    _, stmts = _safe_loads_from_blob(raw_contents)
    return stmts


def _read_ast_with_yvan(in_file, context: Context):
    try:
        from renpy.loader import YVANeusEX  # type: ignore
    except Exception as exc:
        context.set_error(exc)
        raise

    raw = in_file.read()
    if not raw.startswith(b"RENPY RPC2"):
        raise RuntimeError("YVANeusEX requires RPYC2 header")

    position = 10
    chunks = {}
    while position + 12 <= len(raw):
        slot, start, length = struct.unpack("III", raw[position: position + 12])
        if slot == 0:
            break
        chunks[slot] = raw[start: start + length]
        position += 12

    if 1 not in chunks or 2 not in chunks:
        raise RuntimeError("YVANeusEX slots missing")

    decrypted = (
        YVANeusEX.encrypt(bytearray(chunks[1]), YVANeusEX.cipherkey, True)
        + YVANeusEX.encrypt(bytearray(chunks[2]), YVANeusEX.cipherkey, True)
    )

    _, stmts = _safe_loads_from_blob(decrypted)
    return stmts


def _get_ast(
    input_path: Path,
    context: Context,
    try_harder: bool,
    use_runtime: bool,
    use_yvan: bool,
    auto_retry: bool,
):
    def attempt_unrpyc():
        unrpyc = import_unrpyc()
        with input_path.open("rb") as in_file:
            return unrpyc.read_ast_from_file(in_file, context)

    def attempt_deobfuscate():
        deobfuscate = import_unrpyc_deobfuscate()
        apply_deobfuscate_patches(deobfuscate)
        with input_path.open("rb") as in_file:
            return deobfuscate.read_ast(in_file, context)

    def attempt_runtime():
        with input_path.open("rb") as in_file:
            return _read_ast_from_runtime(in_file, context)

    def attempt_yvan():
        with input_path.open("rb") as in_file:
            return _read_ast_with_yvan(in_file, context)

    attempts = []
    if try_harder and not auto_retry:
        attempts.append(attempt_deobfuscate)
    else:
        attempts.append(attempt_unrpyc)
        if try_harder:
            attempts.append(attempt_deobfuscate)

    if use_runtime:
        attempts.append(attempt_runtime)
    if use_yvan:
        attempts.append(attempt_yvan)

    last_exc: Optional[BaseException] = None
    for attempt in attempts:
        try:
            return attempt()
        except BaseException as exc:
            last_exc = exc
            continue
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("No AST read attempts were configured.")


def _decompile_ast(
    ast,
    out_path: Path,
    profile: DecompilerProfile,
    init_offset: bool,
    translator=None,
):
    decompiler_module = import_unrpyc_decompiler()
    gideon = import_gideon_decompiler() if profile.screenlang_v1 else None
    DecompilerClass = build_decompiler_class(decompiler_module, profile, gideon)

    options = decompiler_module.Options(
        log=[],
        translator=translator,
        init_offset=init_offset,
        sl_custom_names=None,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as out_file:
            decompiler = DecompilerClass(out_file, options)
            decompiler.dump(ast)
        temp_path.replace(out_path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass


def _dump_ast(ast, out_path: Path):
    decompiler_module = import_unrpyc_decompiler()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as out_file:
            decompiler_module.astdump.pprint(out_file, ast)
        temp_path.replace(out_path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass


def decompile_paths(
    paths: Iterable[Path],
    *,
    output_dir: Optional[Path] = None,
    base_dir: Optional[Path] = None,
    recursive: bool = True,
    overwrite: bool = False,
    try_harder: bool = False,
    dump: bool = False,
    init_offset: bool = True,
    mode: str = "auto",
    profiles: Optional[Sequence[str]] = None,
    use_runtime: bool = False,
    use_yvan: bool = False,
    renpy_path: Optional[Path] = None,
    auto_retry: bool = True,
    legacy_fallback: bool = True,
) -> List[DecompileResult]:
    if mode == "legacy" and not profiles:
        from .rpyc_legacy import decompile_paths_legacy

        return decompile_paths_legacy(
            paths,
            output_dir=output_dir,
            base_dir=base_dir,
            recursive=recursive,
            overwrite=overwrite,
            try_harder=try_harder,
            dump=dump,
            init_offset=init_offset,
            use_runtime=use_runtime,
            use_yvan=use_yvan,
            renpy_path=renpy_path,
            auto_retry=auto_retry,
        )

    if renpy_path is not None:
        sys.path.insert(0, str(renpy_path))

    extend_class_factory()

    profile_list = resolve_profiles(mode, profiles)
    results: List[DecompileResult] = []

    for path in iter_files(paths, recursive):
        if path.suffix.lower() not in (".rpyc", ".rpymc"):
            continue

        output_path = _output_path(path, output_dir, base_dir, dump)
        if output_path.exists() and not overwrite:
            results.append(DecompileResult(path, output_path, "skip"))
            continue

        context = Context()

        try:
            ast = _get_ast(path, context, try_harder, use_runtime, use_yvan, auto_retry)
        except BaseException as exc:
            if auto_retry and legacy_fallback and mode != "legacy":
                from .rpyc_legacy import decompile_paths_legacy

                legacy_results = decompile_paths_legacy(
                    [path],
                    output_dir=output_dir,
                    base_dir=base_dir,
                    recursive=False,
                    overwrite=overwrite,
                    try_harder=try_harder,
                    dump=dump,
                    init_offset=init_offset,
                    use_runtime=use_runtime,
                    use_yvan=use_yvan,
                    renpy_path=renpy_path,
                    auto_retry=auto_retry,
                )
                if legacy_results:
                    legacy_result = legacy_results[0]
                    results.append(
                        DecompileResult(
                            legacy_result.input_path,
                            legacy_result.output_path,
                            legacy_result.state,
                            error=legacy_result.error,
                            log=legacy_result.log,
                        )
                    )
                    continue
            results.append(DecompileResult(path, output_path, "error", error=exc, log=context.log_contents))
            continue

        if dump:
            try:
                _dump_ast(ast, output_path)
                results.append(DecompileResult(path, output_path, "ok", log=context.log_contents))
            except BaseException as exc:
                results.append(DecompileResult(path, output_path, "error", error=exc, log=context.log_contents))
            continue

        success = False
        last_error: Optional[BaseException] = None

        for profile in profile_list:
            try:
                _decompile_ast(ast, output_path, profile, init_offset)
                success = True
                break
            except BaseException as exc:
                last_error = exc

        if success:
            results.append(DecompileResult(path, output_path, "ok", log=context.log_contents))
            continue

        if auto_retry and legacy_fallback and mode != "legacy":
            from .rpyc_legacy import decompile_paths_legacy

            legacy_results = decompile_paths_legacy(
                [path],
                output_dir=output_dir,
                base_dir=base_dir,
                recursive=False,
                overwrite=overwrite,
                try_harder=try_harder,
                dump=dump,
                init_offset=init_offset,
                use_runtime=use_runtime,
                use_yvan=use_yvan,
                renpy_path=renpy_path,
                auto_retry=auto_retry,
            )
            if legacy_results:
                legacy_result = legacy_results[0]
                results.append(
                    DecompileResult(
                        legacy_result.input_path,
                        legacy_result.output_path,
                        legacy_result.state,
                        error=legacy_result.error,
                        log=legacy_result.log,
                    )
                )
                continue

        results.append(
            DecompileResult(path, output_path, "error", error=last_error, log=context.log_contents)
        )

    return results
