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
- Auto-retry is enabled by default for extraction/decompilation; disable with `--no-auto-retry`.
- Auto/current decompile will fall back to legacy unless `--no-legacy-fallback` is provided.
- `extract --detect-all` and `detect --deep` scan by archive signature instead of extensions.
