# ScummVM

This game type covers adventure games supported by [ScummVM](https://www.scummvm.org/), played from their original data files. MacLauncher downloads ScummVM's macOS disk images from the [ScummVM publisher](https://downloads.scummvm.org/frs/scummvm/), and games do not have to be added to ScummVM's own game list.

## Accepted inputs

Import accepts a game folder, a recognized data file or the game's Windows executable, and recognizes common SCUMM, SCI, AGI, Sky, Queen, Adventure Game Studio, Mohawk, Wintermute, Director, Grim, Tinsel, Toon, Blade Runner and Gob layouts. Some releases and less common engines use other layouts.

A `.scummvm` file inside the game folder selects ScummVM explicitly. An empty file selects automatic detection, and a single-line game ID such as `scumm:monkey` selects an edition. The marker only selects the runtime; the chosen ScummVM release still has to support the actual game files. Complete games and demos must include the files listed in [ScummVM's game documentation](https://wiki.scummvm.org/index.php?title=Category:Supported_Games).

## Game editions

ScummVM identifies the exact game and edition at launch. **Identify game edition**, in the inspector's Advanced group, reports the recognized IDs before launch, using the ScummVM runtime, although Play does not need it. The **Game ID override** setting selects one edition when a folder contains several.

## Saves and storage

Saves, configuration and logs are private to each library entry under Application Support. Removing a game deletes this data and keeps any explicit custom save folder.

## Settings

Runtime Settings cover fullscreen, aspect-ratio correction, image filtering, graphics mode, 3D renderer, language, and separate music, speech and effects volumes. Each can be set globally or overridden for one game.

## Inspector tools

**Extract game archives** appears for Gob STK/ITK/LTK/JTK files and Kyrandia DOS PAK files and uses [ScummVM Tools](https://github.com/scummvm/scummvm-tools) to export each archive into its own folder. **Reveal extracted files** opens the output in Finder.

Classic Gob archives are supported; STK 2.1 and Amiga PAK layouts are not. The official Mac tools package uses Intel code and needs Rosetta on Apple Silicon. It does not include the script decompilers, so the action exports resources and does not decompile complete games.

## Runtimes

### ScummVM

**Runtimes → ScummVM** lists the publisher's releases from 2.5.0 onward, one folder per release. A release's Mac download is the publisher's usual disk image or, when the release renames it or uses another archive format, a Mac download in the release folder. Each download is checked against the SHA-256 file the publisher lists beside it; when there is none, installation records a local SHA-256. ScummVM Tools also lists Apple Silicon and Intel packages from MacLauncher Builds alongside the publisher's versions. Automatic selection prefers a known native build for the launcher process, while saved choices and installed versions remain usable offline. The existing build and source controls expose alternate downloads. ScummVM's own automatic update checks are turned off when MacLauncher starts it, so versions change only through **Runtimes**.

Installation keeps the publisher's universal Mac binary, framework layout and license notices. It records the app's own version, checks that the native components run on this Mac's CPU, then signs the copied native components, nested frameworks and application ad hoc, without the hardened runtime, so that the shared graphics layer can load. The installation record keeps the resulting signatures and file hashes, and later launches verify them.

An existing installation that still carries the publisher's signatures is re-signed the same way the first time graphics injection needs it. Play first verifies its original executable and signed resource tree and keeps the selected version, with no download or reinstall. Status checks, selection and launches without graphics injection leave the earlier signatures in place.

The ScummVM packages support Apple Silicon and Intel. Apple Silicon requires macOS 11 or later, and MacLauncher's own minimum macOS version also applies. Game support differs between ScummVM releases; the publisher's [compatibility lists](https://www.scummvm.org/compatibility/) describe which games each release supports.

### CrossOver and Sikarugir

When the game includes a compatible x86 or x64 Windows executable, the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types) Sikarugir and CrossOver are also offered.

## Licenses

ScummVM and ScummVM Tools are licensed under GPL 3 or later. The official app bundles and tools keep their included license notices and third-party acknowledgments. Matching source releases are available from the [official source archive](https://downloads.scummvm.org/frs/scummvm/), the [ScummVM source repository](https://github.com/scummvm/scummvm) and the [ScummVM Tools source repository](https://github.com/scummvm/scummvm-tools).
