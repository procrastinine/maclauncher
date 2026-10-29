# Installer reader

[innoextract](https://github.com/dscharrer/innoextract) reads Inno Setup offline
installers as data. The managed reader is listed under Runtimes → Tools →
Installer reader. Import and RTP preparation request consent to download the selected
version when it is missing, then resume. No account, `gh` or compiler is required.
The reader does not add a separate game engine.

Installer input consists of the `.exe` and its numbered `.bin` parts in the same folder. Missing data reports the
required filenames. Successful extraction becomes one private cached generation,
then normal engine detection selects the runtime. The reader accepts unencrypted
Inno Setup payloads.

An existing game's cache stays reusable when installer and reader bytes match
despite changed filesystem metadata. Warm imports use file metadata; any drift
requires checksum verification. Separate library entries keep separate game
data. Original installer files remain unchanged.

MacLauncher Builds publishes the reader from upstream innoextract, built with
static Boost components and Apple's system compression libraries. Each package
records its exact archive and manifest checksums, supported architectures,
minimum macOS, executable hashes, licenses, dependencies and source identities.
Installed versions remain usable offline. When no published package supports
the Mac's architecture, Inno Setup imports report the reader as unavailable.
