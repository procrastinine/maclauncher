# Installer reader

Some games are distributed as Inno Setup offline installers. MacLauncher reads these installers as data, without running them, using its installer reader, [innoextract](https://github.com/dscharrer/innoextract). The reader is used both when such a game is imported and when RPG Maker RTP packs are prepared. It adds no game engine of its own, so after extraction, ordinary engine detection selects the runtime.

The reader is listed in **Runtimes → Tools → Installer reader**. When an import or RTP preparation needs it and it is missing, it is downloaded [like any runtime](../runtimes/README.md#downloads-and-offline-use), without an account or `gh`.

## Input

The reader accepts unencrypted Inno Setup installers. Such an installer consists of its `.exe` and the numbered `.bin` data parts in the same folder, and when a part is missing, the error names the required files.

A successful extraction is stored once in launcher data, where it becomes the game's writable source folder, so saves, patches and added assets remain in that folder. Later imports reuse it when the installer and reader bytes match, without scanning or checksumming the folder's contents. Separate library entries keep separate game data. Reuse is described in full in [Installer extraction](../library/GAME_PREPARATION.md#installer-extraction).

## FreeArc payloads

Some Inno Setup installers keep their game data in separate FreeArc `.bin` archives. The reader recognizes the archive format and reads the installer's temporary `arc.ini` and decoder files with innoextract. The installer itself is never executed. The decoded game uses the same storage, extraction record and ordinary import path as other Inno Setup games.

**FreeArc decoders** appears beside the installer reader in **Runtimes → Tools**. FreeArc's built-in methods, including delta, dispack, LZMA, Tornado, LZP and REP, decode with native Mac tools. The `4x4` container decodes blocks concurrently and writes them in archive order.

On Apple Silicon, SREP chains use an installed native **SREP** tool from [mac-game-porter releases](https://github.com/KarmSakha/mac-game-porter/releases). The installed archive reader can offer this separate download when it identifies a SREP chain. The release's full SHA-256 digest is checked before extracting only its SREP executable, whose actual Mac CPU code is inspected. SREP format 4 receives a seekable input file. If the download is declined or unavailable, or the host is Intel, extraction uses the SREP decoder shipped inside the installer under the selected Wine. A missing installer decoder produces an error.

Other external commands from `arc.ini`, CLS plugins and seekable decoders such as xtool use the selected Wine runtime in a disposable private prefix. CLS plugins require a Wine that runs 32-bit Windows programs; every Intel Wine and the publisher-signed Apple Silicon Wines provide that support. Native methods do not start Wine. One consent request lists missing extraction tools, the selected Wine and any required Rosetta prerequisite before downloads begin. When the installed reader identifies SREP, that request also covers the optional native SREP download. An installer needing the archive readers first uses its supplied Windows SREP decoder. Existing CrossOver bottles are not used for extraction or modified; after import, the game can use its chosen runtime and bottle normally.

**FreeArc decoders** and **SREP** have separate entries in **Runtimes → Tools**. Refresh lists publisher versions; installed versions can be deleted or made the default, and custom local files or folders can be registered after CPU and required-file checks. A custom FreeArc package keeps its manifest, native filter and Windows CLS host together. A custom SREP selection identifies the SREP executable, including inside its publisher's app folder. A usable installed tool is selected without a download, consent request or background refresh.

Each extracted file must match its recorded size and CRC. Descriptor and directory tables also have their checksums checked. Invalid paths, conflicting files, truncated data and decoder failures stop extraction and remove incomplete game output. The installer's `unarc.dll` is never loaded.

## Packages

The reader is published by MacLauncher Builds, built from upstream innoextract with static Boost components and Apple's system compression libraries. Each package records its exact archive and manifest checksums, supported architectures, minimum macOS, executable hashes, licenses, dependencies and exact upstream source. If no published package supports the Mac's architecture, Inno Setup imports report that the reader is unavailable.

The separate FreeArc decoder package is built from FreeArc 0.67 (GPL-2.0) and the MIT mac-game-porter helpers. Its native filter and Windows CLS host retain their source references and notices. SREP is not included in this package. Decoder executables extracted from an installer remain private temporary inputs and are not added to the managed tool package.
