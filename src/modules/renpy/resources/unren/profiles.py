from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional


@dataclass(frozen=True)
class DecompilerProfile:
    name: str
    footer_lines: List[str]
    legacy_return_suppression: bool = False
    legacy_python_block: bool = False
    legacy_lex: bool = False
    legacy_else_detection: bool = False
    screenlang_v1: bool = False
    translate_say: bool = False


_UPSTREAM_FOOTER = [
    "# Decompiled by unrpyc: https://github.com/CensoredUsername/unrpyc",
]

_UNREN_V2_FOOTER = [
    "",
    "# Decompiled by unrpyc {v2.0.2}: https://github.com/CensoredUsername/unrpyc dev-branch 01/02/26",
    "# Modified by JoeLurmel with PR #248, #251 , #266 + INCETON",
]

_UNREN_V1_FOOTER = [
    "",
    "# Decompiled by unrpyc {v1.3.2}: https://github.com/CensoredUsername/unrpyc dev-branch",
]

PROFILES = {
    "upstream": DecompilerProfile(
        name="upstream",
        footer_lines=_UPSTREAM_FOOTER,
    ),
    "unren": DecompilerProfile(
        name="unren",
        footer_lines=_UNREN_V2_FOOTER,
        legacy_return_suppression=True,
        legacy_python_block=True,
        legacy_lex=True,
        legacy_else_detection=True,
        translate_say=True,
    ),
    "gideon": DecompilerProfile(
        name="gideon",
        footer_lines=_UNREN_V1_FOOTER,
        legacy_return_suppression=True,
        legacy_python_block=True,
        legacy_lex=True,
        legacy_else_detection=True,
        translate_say=True,
        screenlang_v1=True,
    ),
}


def resolve_profiles(mode: str, explicit: Optional[Iterable[str]] = None) -> List[DecompilerProfile]:
    if explicit:
        result = []
        for name in explicit:
            profile = PROFILES.get(name)
            if profile:
                result.append(profile)
        return result

    mode = (mode or "auto").lower()
    if mode == "legacy":
        return [PROFILES["gideon"], PROFILES["unren"], PROFILES["upstream"]]
    if mode == "current":
        return [PROFILES["upstream"], PROFILES["unren"], PROFILES["gideon"]]

    return [PROFILES["upstream"], PROFILES["unren"], PROFILES["gideon"]]
