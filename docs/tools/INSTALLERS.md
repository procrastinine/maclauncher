# Installer reader

MacLauncher's installer reader is [innoextract](https://github.com/dscharrer/innoextract), which reads Inno Setup offline installers as data. MacLauncher uses it when importing a game distributed as an Inno Setup installer and when preparing RPG Maker RTP packs. It adds no game engine of its own: after extraction, ordinary engine detection selects the runtime.

**Runtimes → Tools → Installer reader** manages the reader. An import or RTP preparation that needs a missing reader downloads it [like any runtime](../runtimes/README.md#downloads-and-offline-use), without an account or `gh`.

## Input

The reader accepts unencrypted Inno Setup installers. An installer consists of its `.exe` and the numbered `.bin` data parts in the same folder, and if a part is missing, the error names the required files.

A successful extraction is stored once in launcher data and becomes the game's writable source folder. Later imports reuse it when the installer and reader bytes match. Saves, patches and added assets remain in that folder; reuse does not scan or checksum its contents. Separate library entries keep separate game data. [Installer extraction](../library/GAME_PREPARATION.md#installer-extraction) describes reuse in full.

## Packages

MacLauncher Builds publishes the reader, built from upstream innoextract with static Boost components and Apple's system compression libraries. Each package records its exact archive and manifest checksums, supported architectures, minimum macOS, executable hashes, licenses, dependencies and exact upstream source. When no published package supports the Mac's architecture, Inno Setup imports report that the reader is unavailable.
