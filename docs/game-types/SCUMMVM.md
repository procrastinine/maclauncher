# ScummVM

This game type covers adventure games supported by [ScummVM](https://www.scummvm.org/), played from their original data files. MacLauncher downloads ScummVM's macOS disk images from the [ScummVM publisher](https://downloads.scummvm.org/frs/scummvm/), and games do not have to be added to ScummVM's own game list first.

## Accepted inputs

Import accepts a game folder, a recognized data file or the game's Windows executable. It recognizes common SCUMM, SCI, AGI, Sky, Queen, Adventure Game Studio, Mohawk, Wintermute, Director, Grim, Tinsel, Toon, Blade Runner and Gob layouts, although some releases and less common engines use other layouts.

A `.scummvm` file inside the game folder selects ScummVM explicitly. When the file is empty, ScummVM detects the game automatically, and a single-line game ID such as `scumm:monkey` selects an edition. This marker only selects the runtime, so the chosen ScummVM release still has to support the actual game files. Complete games and demos must include the files listed in [ScummVM's game documentation](https://wiki.scummvm.org/index.php?title=Category:Supported_Games).

## Game editions

ScummVM identifies the exact game and edition itself at launch. To see the recognized IDs before launch, **Identify game edition** in the inspector's Advanced group asks the ScummVM runtime for them, although Play does not need this step. When a folder contains several editions, the **Game ID override** setting selects one.

## Saves and storage

Saves, configuration and logs are kept privately for each library entry under Application Support. Removing a game deletes this data but keeps any explicit custom save folder.

## Settings

Runtime Settings cover fullscreen, aspect-ratio correction, image filtering, graphics mode, 3D renderer, language, and separate music, speech and effects volumes. Each setting can be set globally or overridden for one game.

## Inspector tools

For Gob STK/ITK/LTK/JTK files and Kyrandia DOS PAK files, **Extract game archives** uses [ScummVM Tools](https://github.com/scummvm/scummvm-tools) to export each archive into its own folder, and **Reveal extracted files** opens the output in Finder.

Classic Gob archives are supported, but STK 2.1 and Amiga PAK layouts are not. The official Mac tools package uses Intel code, so it needs Rosetta on Apple Silicon. Because the package does not include the script decompilers, the action exports resources and does not decompile complete games.

## Runtimes

### ScummVM

**Runtimes → ScummVM** lists the publisher's releases from 2.5.0 onward, which the publisher keeps in one folder per release. A release's Mac download is the publisher's usual disk image or, when the release renames it or uses another archive format, a Mac download in the release folder. Each download is checked against the SHA-256 file the publisher lists beside it, and when there is none, installation records a local SHA-256. For ScummVM Tools, Apple Silicon and Intel packages from MacLauncher Builds are listed alongside the publisher's versions. Automatic selection prefers a known native build for the launcher process, while saved choices and installed versions remain usable offline, and alternate downloads are available from the build and source controls. When MacLauncher starts ScummVM, it turns off ScummVM's own automatic update checks, so versions change only through **Runtimes**.

Installation keeps the publisher's universal Mac binary, framework layout and license notices. It records the app's own version and checks that the native components run on this Mac's CPU. Then it signs the copied native components, nested frameworks and application ad hoc, without the hardened runtime, so that the shared graphics layer can load. The resulting signatures and file hashes are kept in the installation record and verified at later launches. The inspector verifies an installation once, when the launcher starts, and reuses that result for its rows until the runtime inventory changes.

An existing installation that still carries the publisher's signatures is re-signed the same way the first time graphics injection needs it. Before re-signing, Play verifies the original executable and signed resource tree, and it keeps the selected version without downloading or reinstalling anything. Status checks, selection and launches without graphics injection leave the earlier signatures in place.

The ScummVM packages support Apple Silicon and Intel. On Apple Silicon they require macOS 11 or later, and MacLauncher's own minimum macOS version also applies. Game support differs between ScummVM releases, and the publisher's [compatibility lists](https://www.scummvm.org/compatibility/) show which games each release supports.

### CrossOver, Sikarugir and WineCX

When the game includes a compatible x86 or x64 Windows executable, the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types) Sikarugir, CrossOver and WineCX are also offered.

## Licenses

ScummVM and ScummVM Tools are licensed under GPL 3 or later, and the official app bundles and tools keep their included license notices and third-party acknowledgments. Matching source releases are available from the [official source archive](https://downloads.scummvm.org/frs/scummvm/), the [ScummVM source repository](https://github.com/scummvm/scummvm) and the [ScummVM Tools source repository](https://github.com/scummvm/scummvm-tools).
