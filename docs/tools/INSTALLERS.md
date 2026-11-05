# Installer reader

Some games are distributed as Inno Setup offline installers. MacLauncher reads these installers as data with its installer reader, [innoextract](https://github.com/dscharrer/innoextract), both when importing such a game and when preparing RPG Maker RTP packs. The reader adds no game engine of its own: after extraction, ordinary engine detection selects the runtime.

**Runtimes → Tools → Installer reader** manages the reader. An import or RTP preparation that needs a missing reader downloads it [like any runtime](../runtimes/README.md#downloads-and-offline-use), without an account or `gh`.

## Input

The reader accepts unencrypted Inno Setup installers. An installer consists of its `.exe` and the numbered `.bin` data parts in the same folder, and if a part is missing, the error names the required files.

A successful extraction is stored once in launcher data, where it becomes the game's writable source folder, and saves, patches and added assets remain in that folder. Later imports reuse it when the installer and reader bytes match, and this reuse does not scan or checksum the folder's contents. Separate library entries keep separate game data. [Installer extraction](../library/GAME_PREPARATION.md#installer-extraction) describes reuse in full.

## Packages

MacLauncher Builds publishes the reader, built from upstream innoextract with static Boost components and Apple's system compression libraries. Each package records its exact archive and manifest checksums, supported architectures, minimum macOS, executable hashes, licenses, dependencies and exact upstream source. When no published package supports the Mac's architecture, Inno Setup imports report that the reader is unavailable.
