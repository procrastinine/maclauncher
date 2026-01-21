from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parent


def third_party_dir() -> Path:
    return Path(__file__).resolve().parent / "third_party"


def rpatool_dir() -> Path:
    return third_party_dir() / "rpatool"


def unrpyc_dir() -> Path:
    return third_party_dir() / "unrpyc"


def gideon_dir() -> Path:
    return third_party_dir() / "UnRen-Gideon-mod-"


def unrpyc_legacy_dir() -> Path:
    return third_party_dir() / "unrpyc-legacy"


def unrpyc_legacy_py3_dir() -> Path:
    return third_party_dir() / "unrpyc-legacy-py3"
