# CatSystem2

CatSystem2 is a Windows visual novel engine. Its games keep their scenes and other data in KIF archives, the `.int` files, which can be encrypted. Without a native CatSystem2 interpreter, MacLauncher identifies CatSystem2 games, decodes their archives and scripts in the inspector, and plays the original Windows executable through CrossOver or Sikarugir (Wine).

| Runtime | Description |
| --- | --- |
| Archive and script tools (default) | Detection and inspector tools; does not launch the game |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Detection and versions

Detection requires both a structurally valid `scene.int` KIF archive and an independently identified original CatSystem2 executable. It checks the selected folder and its `data/` subfolder and keeps file name case. The engine version is the fixed PE version of the original executable; a loader's product version is not treated as the engine version. Nothing is extracted during import.

The inspector shows the archive format, the native requirements and the support status.

## Script and archive export

**Export scripts**, in the inspector's **Scripts** group, decodes CatScene programs (`.cst`), localization tables (`.cstl`) and compressed front-end text (`.fes`) directly from the original archives. For each member, the output contains the decoded file, typed JSON and a readable UTF-8 transcript. Command lines and unknown line types are preserved.

The **Advanced** group adds:

- **Inspect archives**, which reports the formats, encryption, members and original engine version.
- **Inspect scripts**, which reports the script count, languages and unknown line types without exporting anything.
- **Export scene archive**, which exports `scene.int` by default. The backend API can select another identified `.int` archive by file name.

Exports are written to `userData/games/<gameId>/modules/catsystem2/`. Each archive generation is exported to its own folder, named by its numeric index, even when generations repeat file names, so an export never silently picks one generation.

## Archive formats and images

Encrypted KIF archives are read with the MacLauncher KIF cipher helper 1.0.0, a universal Intel and Apple Silicon executable included with MacLauncher. It requires macOS 11.0, uses the system CommonCrypto library and is checked before each use against its recorded source, executable, manifest, CPU slices and signature. The original `KEY_CODE` and `V_CODE2` resources are read by a PE parser with size limits. The keys stay in memory and reach the helper over standard input.

- The reader supports the published KIF layout with 64-byte names, the 1999 Mersenne Twister seed recurrence, Beaufort-encoded names and little-endian Blowfish blocks. The final incomplete block of an encrypted member stays plaintext.
- CatScene tables and zlib lengths are checked. CSTL files need their zero reserved header and valid UTF-8 language records.
- Text is decoded with the included `cp932-2.01-eudc-ml1` mapping, independent of Node's ICU version. App builds, checkout setup and local packaging generate this table with one preparation step, from public Unicode mapping text with a recorded checksum. FES text is decoded as strict CP932 by default; when CP932 rejects the bytes, the reader falls back to strict UTF-8 and records which encoding it used.
- Unknown key resources and archive variants fail with a specific format error.
- Index reading, decompression and exports have overall byte and count limits, and an operation stops if a source file changes while it runs.

The included HG-3 image reader supports lossless 24-bit and 32-bit frames within size limits, cropped RGBA output, canvas offsets and repeated frame IDs. It adapts algorithms from [TriggersTools.CatSystem2](https://github.com/trigger-segfault/TriggersTools.CatSystem2). Decoding images never runs KCS or FES programs.

## Runtimes

### Archive and script tools

Archive and script tools, the default runtime, provides detection, the engine version and the inspector tools but cannot launch the game. [FelineSystem2](https://github.com/kokseen1/FelineSystem2) does not play CatSystem2 games, so MacLauncher uses it only as a reference and neither runs nor distributes it.

### CrossOver and Sikarugir (Wine)

Play runs the original Windows executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application when one is available, and otherwise through [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). Either one can be chosen in the game's runtime selector, and detection, the engine version and the archive and script tools stay available with both.

## Source and licenses

MacLauncher's archive, script and text readers follow the [KIF](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/KIF-Archive), [key resource](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/V_CODEs), [MT1999](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/Mersenne-Twister), [CatScene](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/CST-Scene), [CSTL](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/CSTL-Scene-Languages) and [FES](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/FES-Screen) format documentation from [TriggersTools.CatSystem2](https://github.com/trigger-segfault/TriggersTools.CatSystem2).

The [HG-3 reader](../../src/modules/catsystem2/image-hg3.js) is written for Node and keeps the [MIT notice](../../src/modules/catsystem2/resources/TriggersTools-MIT.txt) of the code it adapts.

The cipher helper's C source is [kif-crypto.c](../../src/modules/catsystem2/runtime/kif-crypto.c), and its [build script](../../src/modules/catsystem2/runtime/stage-crypto.cjs) uses Apple's Command Line Tools. Both are kept in the matching MacLauncher release commit. [Runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) describes the included helpers.
