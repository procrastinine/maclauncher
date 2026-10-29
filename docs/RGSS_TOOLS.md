# RGSS script and inspection tools

The RGSS module supplies offline Node backends for ordered Ruby script export/repack, portable save discovery, and read-only Ruby Marshal graph inspection. Electron only supplies file selection and reveal services. The same module actions work from the backend with explicit payload paths.

## Scripts workflow

In the game's **Ruby scripts** actions, choose **Export Ruby scripts**, then **Reveal scripts**. Edit the exported `.rb` files, then choose **Repack edited scripts**. Each export creates a separate working folder; exporting again leaves earlier edits intact.

Script lookup reads the `[Game] Scripts` entry in `Game.ini` or finds `Data/Scripts.rxdata`, `.rvdata`, or `.rvdata2`, including case differences. Encrypted script archives use the game’s extraction step. Paths in INI files must remain inside the content root. Packaged games need their existing extraction step before their script archive can be read.

Exports live under `userData/games/<gameId>/modules/rgss/tools/scripts/<exportId>/` and contain:

- `original.bin`: the original Marshal bytes, retained as the baseline.
- `manifest.json`: engine variant, selected MKXP-Z version when configured, original hash, record order, IDs, names as base64 bytes, source/compressed hashes and node identities.
- `<index>-<id>.rb`: each script's exact inflated source bytes. Duplicate IDs/names and empty names remain separate records. Filenames do not use potentially unsafe script names.

The repacker checks the manifest against its original baseline, rejects missing files, changed identities/order, symbolic-link files, and conflicting edits to shared compressed payloads. It preserves original compressed bytes for untouched scripts. Edited sources replace only the corresponding existing String byte sequence; object and symbol tables, encoding ivars, names, aliases and other serialized data remain in place. No-edit repacks are byte-identical to the original archive.

Each output is a new file under `tools/repacked/`. Source game files are not overwritten. Installing a repacked archive and executing edited scripts is a separate user decision. This recovers Ruby source stored in the game; it does not decompile native executable code or reconstruct missing DLLs/editor assets.

## Saves and databases

**Find portable saves** reports stock `Save*.rxdata` (XP), `Save*.rvdata` (VX), and `Save*.rvdata2` (Ace) in content roots, plus RGSS data/`.sav` files in `Save`/`Saves` subdirectories and a configured save-directory override. It checks the Marshal header, records size/modification time, skips symbolic links and limits the result to 256 files. Root-level database files and `Data/` are excluded from discovery. Games with custom save scripts may require a manually chosen directory through the backend's `directory` payload.

**Inspect save or database** selects a local file and writes a graph report under `tools/reports/`. Each game keeps one current save report and one inspection report there; a successful run replaces the earlier report of the same kind. A headless caller supplies `{ filePath }`. The backend accepts sequential Marshal streams as used by XP/VX saves and resets reference tables per stream. Graph edges are node IDs, so shared references and cycles survive inspection. Raw strings, symbol names, encodings, class names, Float/Bignum representations and opaque `_dump` payloads are retained as bytes, with bounded text previews. Table/Color/Tone payloads remain opaque rather than being guessed or deserialized.

The parser never imports Ruby, resolves classes, calls `_load`/`marshal_load`, evaluates source, or invokes regular expressions from input. It recognizes Marshal 4.8 only and rejects unknown tags, `U` (`marshal_load`), `d` (`_load_data`), `e` (extensions), and `C` (subclasses). Custom ordinary objects and Structs are represented as inert class-name/ivar nodes; `u` payloads are represented as inert bytes. Encoded `_dump` payloads follow Ruby's delayed object-registration rule, preserving subsequent reference IDs.

Default hard limits are 64 MiB input, 250,000 nodes, depth 256, 100,000 entries per collection, 32 MiB per blob and 64 sequential streams. Callers may lower these limits. Script inflation is capped at 8 MiB per source and 128 MiB aggregate source. Truncated blobs, negative lengths, invalid links, oversized input, trailing compressed data and format mismatches produce a decoding error.

The tools inspect saves and export scripts. Save editing is unavailable; original saves remain unchanged.

## Backend API

`src/modules/rgss/marshal.js` provides `parseMarshal`, `resolveNode`, `graphReport`, and a String-byte replacement helper. `script-tools.js` provides `decodeScripts`, `exportScripts`, `repackScripts`, and `writeRepackedScripts`. `tools.js` owns content lookup, discovery and per-game reports. The module exposes `exportScripts`, `repackScripts`, `discoverSaves`, `inspectRgssFile`, `refreshRgssTools`, and `revealScripts` actions. Module actions require a valid `gameId` and `context.userDataDir`.

Script exports preserve the original archive; repacked outputs are separate files. Repacked scripts load through the selected RGSS runtime.
