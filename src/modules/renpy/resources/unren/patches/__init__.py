"""Patch helpers for compatibility profiles."""

from .decompiler import build_decompiler_class  # noqa: F401
from .deobfuscate import apply_deobfuscate_patches  # noqa: F401
from .renpycompat import extend_class_factory, extend_class_factory_module  # noqa: F401
