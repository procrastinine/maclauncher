import importlib
import importlib.util
from importlib.machinery import SourceFileLoader
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
    # Upstream's executable has no .py suffix, so import_module cannot load a
    # pristine submodule checkout. Load that exact file instead of a global
    # Python installation which might happen to provide the same module name.
    name = "unren_rpatool"
    if name not in sys.modules:
        source = rpatool_dir() / "rpatool"
        loader = SourceFileLoader(name, str(source))
        spec = importlib.util.spec_from_loader(name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        sys.modules[name] = module
    return sys.modules[name]


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
