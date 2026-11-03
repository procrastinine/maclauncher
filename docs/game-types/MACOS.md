# macOS Game

This game type covers native Mac games that no engine-specific game type claims: application bundles, launcher scripts and standalone Mach-O executables. Play runs the game's own executable or script, except that apps built only for 32-bit Intel, which current macOS cannot launch directly, run through the [32-bit Mac](#32-bit-mac) runtime. Its module is `generic-app`.

## Accepted inputs

### Applications

Import accepts a macOS application bundle. A publisher application folder without the `.app` suffix also imports when its `Contents/Info.plist` declares an application (`APPL`) and `Contents/MacOS` contains the executable; its original files and launch script stay in place.

The executable is the one named by `CFBundleExecutable`. Without that key, it is the executable named after the bundle, or the only executable in `Contents/MacOS`. The library entry takes its name from `CFBundleDisplayName`, then `CFBundleName`, then the bundle's file name.

Native apps built with a recognized engine keep that engine's game type and module. An app whose executable is built only for 32-bit Intel (i386) is still a macOS Game; it uses the [32-bit Mac](#32-bit-mac) runtime, and no separate game type is assigned.

### Scripts and executables

macOS Game also accepts a selected file of one of these kinds:

- a `.sh`, `.command`, `.bash` or `.zsh` text script;
- an executable file that starts with an absolute interpreter shebang, including `.py` scripts;
- an executable Mach-O `MH_EXECUTE` image, including a file without an extension.

Every slice of a Mach-O executable must use a Mac CPU and, when deployment metadata is present, target macOS or Mac Catalyst. Static and legacy Mac images can omit that metadata. ELF and PE files, object files, libraries and other files that merely have the executable bit do not qualify.

Importing a folder never picks an arbitrary script from it; a script has to be selected directly. Launchers that belong to a recognized engine, including Ren'Py `.sh` and `.py` files, keep their engine's behavior.

### Detection order

macOS Game is a fallback. Detection tries it only after engine-specific layouts and [web content](WEB.md) fail to match, and before the generic [Windows Game](WINDOWS.md) check. [Detection](../library/DETECTION.md) describes the full order.

## Play

Play runs an app's own executable. A selected script or executable runs from its containing folder, and a script runs with its installed interpreter. Shell launchers do not need the executable permission bit. The game's launch arguments are passed to the selected file.

A script runs in its own process group, which counts as the game's lifetime and is the target for Stop, so a game that keeps running after its launcher script exits is still tracked. A process that starts a new session leaves the group and is not tracked.

When a script cannot start because it is not executable, the error points to **Make executable**. A missing script or interpreter produces its own error.

Native window tracking connects launched game windows to the shared graphics controls.

Native games imported from an installed Steam library (`steamapps/common`) receive the application ID from the matching Steam application manifest. [Steam support](../runtimes/STEAM_API.md) describes the requirements.

## Saves

macOS Game has no save editor or cheats. Native macOS and 32-bit Mac keep each game's own save locations and provide no save-location override.

## Inspector tools

The inspector details show the app version, bundle ID and executable.

- **Make executable**, shown for scripts, adds the executable permission bits to the selected script without changing its contents.
- **Inspect binary** runs the shared [native inspection](../tools/NATIVE_INSPECTION.md) on a Mach-O executable or on the executable inside an app bundle. It is hidden for scripts, which can be read directly.
- **Remove quarantine**, in the **App quarantine** row that every game with an app bundle has, removes the download quarantine attribute when macOS reports the app as damaged.

## Runtimes

| Runtime | Used for |
| --- | --- |
| **Native macOS**, default | Apps, scripts and executables that run on current macOS |
| **32-bit Mac** | Apps whose executable is i386 only |

### Native macOS

**Native macOS** runs the game's own app, executable or script and has no download or runtime settings.

#### Graphics

Native apps and executables use the shared **Shaders and filters** and **Scaling and frame generation** controls through the graphics library that is attached at launch. Many published Mac apps have a hardened-runtime or library-validation signature that refuses that library. While the game's graphics need processing, such an app runs from a private copy in the game's data folder: only the refused programs are copied and signed ad hoc, every other file is a link to the original, and the original app is never changed. Only the command runs from the signed copy; arguments, the working directory and environment values keep their original paths. Links beside the copy keep data that the app finds relative to its bundle within reach. With graphics off, the original app runs. Files that the game creates inside the copy, and links that it replaces, survive refreshes and keep the copy from being removed automatically. [Private copies of restricted apps](../graphics/INPUTS_AND_ADAPTERS.md#private-copies-of-restricted-apps) describes the copy, when it is made again or removed, and why apps that use the App Sandbox keep their original rendering.

### 32-bit Mac

**32-bit Mac** runs apps built only for 32-bit Intel (i386) through [mac32](https://github.com/Shagulka/mac32). mac32 loads a 32-bit Intel application in a 64-bit process and translates its system-library calls for current macOS. MacLauncher downloads the publisher's Mac releases of mac32. The runtime has its own section in Settings and its own **Runtimes → 32-bit Mac** tab, but it is not a separate game type: the apps it runs stay macOS Game entries.

#### Which apps use it

An entry uses 32-bit Mac when it is an `.app` bundle whose main executable is an i386 Mach-O file with no arm64 or x86_64 slice. MacLauncher selects 32-bit Mac automatically for these apps and does not offer Native macOS, because current macOS cannot run their executables. Apps that also contain a 64-bit executable keep the native launch. Standalone executables and scripts do not use 32-bit Mac, and the runtime is offered only to macOS Game entries; apps identified as a supported game engine keep that engine's own runtimes.

#### Versions and installation

**Play** launches the imported app with mac32 directly, with no app picker, source build or terminal command.

**Runtimes → 32-bit Mac** lists the mac32 versions, and **Reload versions** reads the publisher's release information. When no version is listed or installed yet, the first Play reads that release information after download consent and installs the newest release.

#### Saves and storage

mac32 reads the imported bundle in its original location and runs from the folder containing the app, matching its upstream launcher. The app inherits the normal user home and temporary directory and chooses its own save and preferences paths. MacLauncher keeps a size-limited runtime log in the entry's launcher data but does not redirect game files or saves there.

Earlier MacLauncher versions gave each mac32 game a private home folder and working folder in launcher data. During the first startup after an upgrade, files the game wrote there are recovered once into the user's home folder and the folder containing the app, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes: files missing there return to their usual relative paths, existing files stay unchanged, and private versions that differ are kept beside them as `<filename>.MacLauncher-conflict-<id>`. The earlier private home folder itself stays in launcher data.

#### Settings

Runtime Settings provide:

- **Application arguments**, one per line.
- **Additional library directory**, an optional folder of compatible 32-bit Mac libraries.
- **Game compatibility patches**, which lets mac32 apply its patches for exact game builds in application memory. The option is off by default, and the patches never change the application's files on disk.

#### Graphics

Apps on 32-bit Mac use the shared **Shaders and filters** and **Scaling and frame generation** controls. Graphics run in mac32's 64-bit Intel host while the app itself stays 32-bit, so the shared graphics manager picks matching Intel libraries, including when mac32 runs through Rosetta on Apple Silicon.

The shared GPU processor handles completed bitmap images on layers that cover the game window, and complete opaque bitmaps drawn during a full-window Quartz view draw. Quartz processing uses a single complete opaque bitmap, and its submission follows the original view's drawing while existing child controls keep their drawing order and input handling.

These paths supply color, dimensions and frame timing to the shared effect pipeline. Spatial scaling and frame generation need a bitmap format without alpha, while color effects on bitmap layers preserve premultiplied transparency. Temporal upscaling also needs game depth and motion vectors.

#### Requirements and compatibility

A mac32 download contains an x86_64 host executable and its i386 guest libraries. Installation reads the minimum macOS version from the downloaded host executable, which can be higher than MacLauncher's own minimum. On Apple Silicon the host also needs [Rosetta](../runtimes/ROSETTA.md), which the shared launch flow offers to install. Renamed release archives are recognized, and installation finds a host or library folder that moved within the package. A release without an Intel Mac download is listed with that reason.

mac32 translates Intel Mac system-library calls, including Carbon and Cocoa APIs, and its [upstream documentation](https://github.com/Shagulka/mac32#readme) lists the implemented interfaces. PowerPC and Windows executables are outside its scope; Windows executables use the [Windows runtimes](WINDOWS.md). Steam's account and ownership requirements still apply to games that need Steam.

#### Source and licenses

Each mac32 download is the publisher's binary release package, used without rebuilding and checked as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity). Each installation records its release, source revision, archive size and checksum.

mac32 is copyright Boris Khesin and licensed under GPL 3 or later. Its guest C++ libraries are under LLVM's Apache 2.0 license with LLVM exception, and the Steamworks.NET interface descriptions under their MIT license. The downloaded package keeps the upstream `COPYING` and `NOTICE` files and includes no games or Apple system files. The matching source of each release is in the [mac32 source repository](https://github.com/Shagulka/mac32) at the release's tag.
