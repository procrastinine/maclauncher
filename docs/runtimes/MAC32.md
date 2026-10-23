# 32-bit Intel Mac applications

[mac32](https://github.com/Shagulka/mac32) loads 32-bit Intel macOS applications
in a 64-bit process and bridges their system-library calls to current macOS.
MacLauncher manages the publisher's versioned Mac downloads.

## Import and runtime selection

Import accepts a macOS `.app` bundle with an i386 Mach-O executable. An
i386-only app detected as a generic macOS application selects **mac32**
automatically. Apps identified as a supported game engine retain that engine's
preferred runtime. Apps with a compatible 64-bit executable retain their ordinary
native launch path.

**Play** requests consent if the selected mac32 version is missing, installs it
and launches the imported app directly. A separate Mac32 installation, app picker,
source build or terminal command is unnecessary. The original application bundle
and executable remain in place. Installed runtime versions are shared across
library entries.

**Runtimes → mac32** lists available and installed versions, the default version
and removal controls. **Reload versions** requests the publisher's release information.
Opening the launcher, selecting an app or opening Runtimes makes no network
request. Installed versions remain available offline; refresh and installation
preserve explicit version choices. A game can select a particular version in its
runtime options.

## Runtime settings and storage

Runtime Settings provide application arguments and an optional additional
library directory. **Game compatibility patches** permits mac32's exact-build patches
in application memory; it is off by default. These patches do not change the
application's files on disk.

MacLauncher supplies a separate working directory, home directory and temporary
directory for each library entry. The imported bundle is read from its original
location. Application code retains its own file-access behavior; these directory
settings do not create a filesystem sandbox.

## Graphics

mac32 uses the shared **Shaders and filters** and **Scaling and frame generation**
controls. Graphics run in mac32's 64-bit Intel host; the game remains 32-bit.
The selected graphics libraries must include Intel support, including when
mac32 runs through Rosetta on Apple Silicon.

Completed bitmap images on layers covering the game window, and complete opaque
bitmaps used during a full-window Quartz view draw, use the shared GPU processor.
Quartz submission follows the original view's drawing; existing child controls
retain their drawing order and input handling. Spatial scaling and frame
generation require a bitmap format without alpha; colour effects on bitmap
layers preserve premultiplied transparency. Bitmap input supplies
colour, dimensions and frame timing; it does not supply game depth or motion
vectors. Effects that require additional renderer inputs depend on those inputs
being available. Quartz processing requires a single complete opaque bitmap;
arbitrary vector compositions are outside this input path.

## Requirements and compatibility

The mac32 0.1 download contains an x86_64 host executable requiring macOS 26 or
later, plus its i386 guest libraries. Apple Silicon also requires
[Rosetta](ROSETTA.md); the shared launch flow requests installation when needed.
This runtime's macOS requirement is higher than MacLauncher's own minimum.

Compatibility depends on the app's imported APIs and native libraries. mac32
bridges a defined set of macOS functions and Objective-C interfaces. Carbon and
Cocoa compatibility depends on the exact APIs supplied by mac32. PowerPC code,
Windows executables and missing game libraries are outside this runtime's input
profile. The [upstream documentation](https://github.com/Shagulka/mac32#readme)
describes its API coverage and runtime limits. Games requiring Steam retain the
running Steam client's account and ownership requirements.

## Source and licenses

Managed release [mac32 0.1](https://github.com/Shagulka/mac32/releases/tag/v0.1) uses
source revision [`dcfed5b9ad1ca1356bddd39ac6a26e564d536c28`](https://github.com/Shagulka/mac32/commit/dcfed5b9ad1ca1356bddd39ac6a26e564d536c28).
The module catalog records the release archive's byte count and SHA-256 checksum.
MacLauncher downloads the publisher's binary package without rebuilding it.

mac32 is copyright Boris Khesin and licensed under GPL 3 or later. Its guest C++
libraries retain LLVM's Apache 2.0 license with LLVM exception; Steamworks.NET
interface descriptions retain their MIT license. The downloaded package preserves
upstream `COPYING` and `NOTICE` files. No games or Apple system files are
included. Matching source is available from the
[mac32 source repository](https://github.com/Shagulka/mac32/tree/dcfed5b9ad1ca1356bddd39ac6a26e564d536c28).
