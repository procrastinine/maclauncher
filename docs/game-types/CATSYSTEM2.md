# CatSystem2

CatSystem2 is a Windows visual novel engine. Its games keep their scenes and other data in KIF archives, the `.int` files, which can be encrypted. No native CatSystem2 interpreter is available, so MacLauncher plays these games by running the original Windows executable through a Wine runtime: CrossOver, Sikarugir or WineCX. It also identifies CatSystem2 games and decodes their archives and scripts in the inspector.

| Runtime | Description |
| --- | --- |
| Archive and script tools (default) | Detection and inspector tools; does not launch the game |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Detection and versions

A game is detected as CatSystem2 only when it has both a structurally valid `scene.int` KIF archive and an independently identified original CatSystem2 executable. Detection looks in the selected folder and its `data/` subfolder, keeps file name case and extracts nothing during import. The engine version is the fixed PE version of the original executable, whereas a loader's product version is not treated as the engine version.

The inspector shows the archive format, the native requirements and the support status.

## Script and archive export

**Export scripts**, in the inspector's **Scripts** group, decodes CatScene programs (`.cst`), localization tables (`.cstl`) and compressed front-end text (`.fes`) directly from the original archives. The output for each member contains the decoded file, typed JSON and a readable UTF-8 transcript, and command lines and unknown line types are preserved.

The inspector's **Advanced** group adds three more tools:

- **Inspect archives**, which reports the formats, encryption, members and original engine version.
- **Inspect scripts**, which reports the script count, languages and unknown line types without exporting anything.
- **Export scene archive**, which exports `scene.int` by default. Through the backend API, another identified `.int` archive can be selected by file name.

Exports are written to `userData/games/<gameId>/modules/catsystem2/`. A patched archive can keep several generations of one member, which are versions with the same file name. Each generation is exported to its own folder, named by its numeric index, so an export never silently picks one of them.

## Archive formats and images

Reading an encrypted KIF archive needs the game's keys and a cipher implementation. The keys come from the original executable's `KEY_CODE` and `V_CODE2` resources, which a PE parser with size limits reads. They stay in memory and reach the cipher over standard input. The cipher itself is the MacLauncher KIF cipher helper 1.0.0, a universal Intel and Apple Silicon executable included with MacLauncher. It requires macOS 11.0 and uses the system CommonCrypto library, and before each use it is checked against its recorded source, executable, manifest, CPU slices and signature.

- The reader supports the published KIF layout with 64-byte names, the 1999 Mersenne Twister seed recurrence, Beaufort-encoded names and little-endian Blowfish blocks. The final incomplete block of an encrypted member stays plaintext.
- CatScene tables and zlib lengths are checked. CSTL files need their zero reserved header and valid UTF-8 language records.
- Text is decoded with the included `cp932-2.01-eudc-ml1` mapping, so decoding does not depend on Node's ICU version. This mapping table is generated from public Unicode mapping text with a recorded checksum, by a single preparation step that app builds, checkout setup and local packaging all use. FES text is decoded as strict CP932 by default; when CP932 rejects the bytes, the reader falls back to strict UTF-8 and records which encoding it used.
- Unknown key resources and archive variants fail with a specific format error.
- Index reading, decompression and exports have overall byte and count limits, and an operation stops if a source file changes while it runs.

For HG-3 images, MacLauncher includes its own reader, which adapts algorithms from [TriggersTools.CatSystem2](https://github.com/trigger-segfault/TriggersTools.CatSystem2). It supports lossless 24-bit and 32-bit frames within size limits, cropped RGBA output, canvas offsets and repeated frame IDs. Decoding images never runs KCS or FES programs.

## Runtimes

### Archive and script tools

Archive and script tools, the default runtime, provides detection, the engine version and the inspector tools but cannot launch the game. [FelineSystem2](https://github.com/kokseen1/FelineSystem2) does not play CatSystem2 games, so MacLauncher uses it only as a reference and neither runs nor distributes it.

### CrossOver, Sikarugir and WineCX

Play runs the original Windows executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application when one is available, and otherwise through [Sikarugir](../runtimes/SIKARUGIR.md). [WineCX](../runtimes/WINECX.md) is offered as well. Any of the three can be chosen in the game's runtime selector, and detection, the engine version and the archive and script tools stay available with each.

## Source and licenses

MacLauncher's archive, script and text readers follow the [KIF](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/KIF-Archive), [key resource](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/V_CODEs), [MT1999](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/Mersenne-Twister), [CatScene](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/CST-Scene), [CSTL](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/CSTL-Scene-Languages) and [FES](https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/FES-Screen) format documentation from [TriggersTools.CatSystem2](https://github.com/trigger-segfault/TriggersTools.CatSystem2).

The [HG-3 reader](../../src/modules/catsystem2/image-hg3.js) is written for Node and keeps the [MIT notice](../../src/modules/catsystem2/resources/TriggersTools-MIT.txt) of the code it adapts.

The cipher helper's C source is [kif-crypto.c](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/catsystem2/runtime/kif-crypto.c). MacLauncher Builds compiles it with Apple's Command Line Tools from its [helper profile](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/helper-builds/catsystem2-kif-crypto.json). [Runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) describes the included helpers.
