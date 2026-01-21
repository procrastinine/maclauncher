import importlib
import sys
from pathlib import Path
from types import ModuleType

from .paths import (
    gideon_dir,
    rpatool_dir,
    unrpyc_dir,
    unrpyc_legacy_py3_dir,
)


def _ensure_on_path(path: Path) -> None:
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)


def _ensure_alias_package(name: str, path: Path) -> None:
    if name in sys.modules:
        return
    package = ModuleType(name)
    package.__path__ = [str(path)]
    sys.modules[name] = package


def import_rpatool():
    _ensure_on_path(rpatool_dir())
    return importlib.import_module("rpatool")


def import_unrpyc():
    _ensure_on_path(unrpyc_dir())
    return importlib.import_module("unrpyc")


def import_unrpyc_decompiler():
    _ensure_on_path(unrpyc_dir())
    return importlib.import_module("decompiler")


def import_unrpyc_deobfuscate():
    _ensure_on_path(unrpyc_dir())
    return importlib.import_module("deobfuscate")


def import_unrpyc_renpycompat():
    _ensure_on_path(unrpyc_dir())
    return importlib.import_module("decompiler.renpycompat")


def import_gideon_unrpyc():
    _ensure_alias_package("unren_gideon", gideon_dir())
    return importlib.import_module("unren_gideon.unrpyc")


def import_gideon_decompiler():
    _ensure_alias_package("unren_gideon", gideon_dir())
    return importlib.import_module("unren_gideon.decompiler")


def import_gideon_deobfuscate():
    _ensure_alias_package("unren_gideon", gideon_dir())
    return importlib.import_module("unren_gideon.deobfuscate")


def import_unrpyc_legacy():
    _ensure_alias_package("unren_legacy", unrpyc_legacy_py3_dir())
    return importlib.import_module("unren_legacy.unrpyc")


def import_unrpyc_legacy_decompiler():
    _ensure_alias_package("unren_legacy", unrpyc_legacy_py3_dir())
    return importlib.import_module("unren_legacy.decompiler")


def import_unrpyc_legacy_deobfuscate():
    _ensure_alias_package("unren_legacy", unrpyc_legacy_py3_dir())
    return importlib.import_module("unren_legacy.deobfuscate")


def import_unrpyc_legacy_renpycompat():
    _ensure_alias_package("unren_legacy", unrpyc_legacy_py3_dir())
    return importlib.import_module("unren_legacy.decompiler.renpycompat")
