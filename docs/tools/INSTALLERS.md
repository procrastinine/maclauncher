# Installer reader

Some games are distributed as Inno Setup offline installers. MacLauncher reads these installers as data, without running them, using its installer reader, [innoextract](https://github.com/dscharrer/innoextract). The reader is used both when such a game is imported and when RPG Maker RTP packs are prepared. It adds no game engine of its own, so after extraction, ordinary engine detection selects the runtime.

The reader is listed in **Runtimes → Tools → Installer reader**. When an import or RTP preparation needs it and it is missing, it is downloaded [like any runtime](../runtimes/README.md#downloads-and-offline-use), without an account or `gh`.

## Input

The reader accepts unencrypted Inno Setup installers. Such an installer consists of its `.exe` and the numbered `.bin` data parts in the same folder, and when a part is missing, the error names the required files.

A successful extraction is stored once in launcher data, where it becomes the game's writable source folder, so saves, patches and added assets remain in that folder. Later imports reuse it when the installer and reader bytes match, without scanning or checksumming the folder's contents. Separate library entries keep separate game data. Reuse is described in full in [Installer extraction](../library/GAME_PREPARATION.md#installer-extraction).

## Packages

The reader is published by MacLauncher Builds, built from upstream innoextract with static Boost components and Apple's system compression libraries. Each package records its exact archive and manifest checksums, supported architectures, minimum macOS, executable hashes, licenses, dependencies and exact upstream source. If no published package supports the Mac's architecture, Inno Setup imports report that the reader is unavailable.
