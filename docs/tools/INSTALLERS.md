# Installer reader

Some games are distributed as Inno Setup offline installers. MacLauncher reads these installers as data, without running them, using its installer reader, [innoextract](https://github.com/dscharrer/innoextract). The reader is used both when such a game is imported and when RPG Maker RTP packs are prepared. It adds no game engine of its own, so after extraction, ordinary engine detection selects the runtime.

The reader is listed in **Runtimes → Tools → Installer reader**. When an import or RTP preparation needs it and it is missing, it is downloaded [like any runtime](../runtimes/README.md#downloads-and-offline-use), without an account or `gh`.

## Input

The reader accepts unencrypted Inno Setup installers. Such an installer consists of its `.exe` and the numbered `.bin` data parts in the same folder, and when a part is missing, the error names the required files.

A successful extraction is stored once in launcher data, where it becomes the game's writable source folder, so saves, patches and added assets remain in that folder. Later imports reuse it when the installer and reader bytes match, without scanning or checksumming the folder's contents. Separate library entries keep separate game data. Reuse is described in full in [Installer extraction](../library/GAME_PREPARATION.md#installer-extraction).

## FreeArc payloads

Some Inno Setup installers keep their game data in separate FreeArc `.bin` archives. The reader recognizes the archive format and reads the installer's temporary `arc.ini` and decoder files with innoextract. The installer itself is never executed. The decoded game uses the same storage, extraction record and ordinary import path as other Inno Setup games.

**FreeArc decoders** appears beside the installer reader in **Runtimes → Tools**. SREP and FreeArc's built-in methods, including delta, dispack, LZMA, Tornado, LZP and REP, decode with native Mac tools. The `4x4` container decodes blocks concurrently and writes them in archive order.

When a compression method requires a Windows decoder supplied inside the installer, that decoder runs under the selected Wine runtime in a disposable private prefix. This includes external commands from `arc.ini`, CLS plugins and seekable decoders such as xtool. Native methods do not start Wine. Required downloads use the normal consent flow. Existing CrossOver bottles are not used for extraction or modified; after import, the game can use its chosen runtime and bottle normally.

Each extracted file must match its recorded size and CRC. Descriptor and directory tables also have their checksums checked. Invalid paths, conflicting files, truncated data and decoder failures stop extraction and remove incomplete game output. The installer's `unarc.dll` is never loaded.

## Packages

The reader is published by MacLauncher Builds, built from upstream innoextract with static Boost components and Apple's system compression libraries. Each package records its exact archive and manifest checksums, supported architectures, minimum macOS, executable hashes, licenses, dependencies and exact upstream source. If no published package supports the Mac's architecture, Inno Setup imports report that the reader is unavailable.

The separate FreeArc decoder package is built from FreeArc, SREP and the MIT mac-game-porter helpers. Its native tools and Windows CLS host retain their source references and notices. Decoder executables extracted from an installer remain private temporary inputs and are not added to the managed tool package.
