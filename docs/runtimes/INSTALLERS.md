# Installer reader

[innoextract](https://github.com/dscharrer/innoextract) reads Inno Setup offline
installers as data. The included Mac profile runs directly; no tool installation,
account, `gh` or end-user compiler is required. It is shared import infrastructure
and does not add a separate game engine.

Add the `.exe` with its numbered `.bin` parts beside it. Missing data reports the
required filenames. Successful extraction becomes one private cached generation,
then normal engine detection decides whether the game is supported. Password
protected installers and additional legacy GOG RAR payloads are unsupported.

An existing game's cache stays reusable when installer and reader bytes match
despite changed filesystem metadata. Warm imports use file metadata; any drift
requires checksum verification. Separate library entries keep separate game
data. Original installer files remain unchanged.

The exact profile is `1.10-dev-6e9e34ed-macos-v1`, from upstream revision
`6e9e34ed0876014fdb46e684103ef8c3605e382e`, with source-built static Boost 1.92
components and Apple's system compression libraries. Its arm64 build requires
macOS 13. The manifest records executable hashes, licenses, dependencies and
source/header/overlay identities. Reload lists the complete upstream tag history;
upstream source tags are distinct from this included Mac binary profile.

Development rebuilds use `runtime/innoextract-build.js`, the pinned read-only
upstream repositories and an explicit matching Boost header SDK. Xcode Command
Line Tools provide Apple's compiler and SDK; CMake and Ninja drive the build.
Build output and owned overlays stay outside `src/external/`.
