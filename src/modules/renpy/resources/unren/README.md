# UnRen Python Tools

Minimal Python 3 tooling for Ren'Py archive extraction and RPYC/RPYMC decompile.

Usage examples:
- `python -m unren extract --mode all --recursive --output out game_dir`
- `python -m unren decompile --try-harder --mode auto --output out game_dir`
- `python -m unren decompile --mode legacy --output out game_dir`
- `python -m unren detect --deep game_dir`

Notes:
- Ren'Py runtime fallback requires the Ren'Py runtime to be importable (use `--renpy-path`).
- Legacy Ren'Py (7 and below) may still require a Python 2 runtime for full compatibility.
- `--mode legacy` uses the Python 3 port of the upstream legacy unrpyc branch.
  `third_party/unrpyc-legacy-py3` is unrpyc's `legacy` branch at v1.3.2 (commit `13f7e0ec56a7134a5afc89d70f3e48823e715f3e`, the `third_party/unrpyc-legacy` Gitlink) with its Python modules converted to Python 3 (package-relative imports, `range`, `str`, bytes literals, `except ... as` and `exec()`). Four edits change behavior: pickles that name `__builtin__` load from `builtins`; `renpycompat` unpickles with ASCII strict decoding; screen language 2 statements without a `location` use `linenumber`; and the deobfuscator decodes hex with `bytes.fromhex` and escapes with `unicode-escape` over Latin-1. The port adds a package `__init__.py` and omits the upstream `testcases` directory and `un.rpyc/corrupy` Gitlink. `scripts/upstream-overlays.json` records it as the `unrpyc-legacy-py3` recipe, and `scripts/check-upstream-overlays.cjs` verifies every file not listed as an owned adaptation against the Gitlink.
- Auto-retry is enabled by default for extraction/decompilation; disable with `--no-auto-retry`.
- Auto/current decompile will fall back to legacy unless `--no-legacy-fallback` is provided.
- `extract --detect-all` and `detect --deep` scan by archive signature instead of extensions.
