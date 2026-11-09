# iOS / iPadOS

This game type covers iPhone and iPad applications packaged as `.ipa` files. MacLauncher runs unencrypted ARM64 applications on Apple Silicon through the PlayTools framework from [PlayCover](https://github.com/PlayCover/PlayCover) and Mac Catalyst; encrypted IPAs cannot be played.

## Library entries

A library entry is named from `CFBundleDisplayName`, falling back to `CFBundleName` and then to the bundle identifier.

For the icon, inspection reads the declared loose PNG variants directly from the package and picks the largest valid one, falling back to conventional application icon file names. Apple's optimized CgBI PNGs, which store non-interlaced 8-bit BGR or BGRA scanlines up to 2048 pixels, are converted to standard PNGs. An application whose icon exists only in a compiled asset catalog (`Assets.car`), however, shows the generic iOS icon. Inspection neither unpacks nor modifies the application.

## Preparation and storage

**Play** prepares the imported IPA and starts the application without the standalone PlayCover app being installed or opened.

Preparation turns the IPA into a Mac Catalyst application. It extracts a private copy of the application, adjusts its Mach-O platform and library load commands, embeds PlayTools and signs the derived app locally. Later launches reuse that copy, and a change to the IPA or the PlayTools version rebuilds it automatically while keeping game data, input settings and keymaps. Nothing is installed in Applications, and SIP, the system signing policy and the original app's permissions are left alone.

The original IPA itself remains at its imported location, and macOS runs the converted Mac Catalyst application from the prepared bundle. When nothing has changed, a launch does not extract, copy, convert or sign the application again. For verified runtime binaries, the recorded hashes are reused when the files have precise change times, while files with only coarse change times are checked byte by byte again. If preparation replaces a private bundle or extracted file that was modified, the modified version is kept.

## Sandbox and network access

The app runs in an OS-enforced file sandbox with its own private home, temporary files and preferences. It can reach only its prepared bundle, its private storage, the selected graphics libraries and required system resources. The original entitlements, account groups, cloud containers, and camera, microphone and location permissions are not imported.

**Network access** is unchecked by default and follows the shared game setting and application policy described in [network isolation](../runtimes/NETWORK_ISOLATION.md). While it is unchecked, IPv4 and IPv6 connections, UDP traffic and DNS are blocked, including loopback access and traffic from child processes. Checking it allows connections, local socket binding and incoming game traffic without relaxing file isolation.

## Graphics

Shared shader effects process supported Metal drawables in place and keep the application's UIKit layers. To apply them to the right window, MacLauncher's iOS graphics adapter matches each drawable's UIKit scene to its live Mac window.

Opaque Metal game layers also support shared spatial scaling and LSFG. For these, MacLauncher places an output layer beneath the existing UIKit controls, so the window keeps its size, and this presentation path submits the drawable's color image. The 1×, 1.5× and 2× resolution settings allocate the game drawable at the output size divided by the selected factor, while Auto keeps the application's requested render size. Transparent game layers, by contrast, support only the in-place color effects.

## Inspector tools

- **Inspect IPA** reads the application identifier, version, architecture and encryption status from the package.
- **Extract IPA contents** exports the package's original resources and compiled binaries to a reusable private folder but does not recover source code.
- **Reveal extracted contents** opens that folder in Finder.
- For unencrypted packages, **Inspect binary** runs the shared [native inspection](../tools/NATIVE_INSPECTION.md) on a private copy of the main executable.

## Runtimes

### PlayCover

**PlayCover** is the only runtime for this game type. Because it needs Apple Silicon, MacLauncher does not offer it on an Intel Mac, and iOS games there show that requirement instead of **Play**.

#### Versions

In **Runtimes → PlayCover**, the refresh control lists [PlayCover releases](https://github.com/PlayCover/PlayCover/releases), including prereleases labeled **Pre-release**.

Play uses the game's explicit version, then the saved default, and without either it uses the newest installed version or else installs the newest listed release.

Each listed PlayCover release is recorded with its source revision and its download, which is the disk image or, when the release has no disk image, a renamed or differently packaged archive. Listed releases require Apple Silicon, so releases without an Apple Silicon download are shown as unavailable.

From a release, MacLauncher keeps only PlayTools. It downloads the selected release directly from the publisher and extracts the bundled PlayTools framework and its library dependencies from wherever the download places them, while the PlayCover application itself is not kept. The archive is checked as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity), the hashes of the PlayTools binary and its dependencies are recorded, and the minimum macOS version is read from the downloaded PlayTools framework. No PlayCover GUI process is used to install or launch games.

#### Settings

Settings → iOS holds the defaults, and each game's Runtime Settings window can override them with the same fields:

- Keyboard and mouse mapping, mouse sensitivity and scroll-wheel gestures.
- Pausing keymapping during text input, which is on by default.
- Window mode and dimensions. The default **Resizable** mode uses PlayTools' window handling to keep the app's display bounds aligned with the Mac window. Fixed dimensions remain available for apps that need them.
- Device model, the iPad or iPhone model that PlayTools reports.

Changes take effect on the next launch and are written to the app's private PlayTools settings without touching existing keymaps. While keyboard and mouse mapping is enabled, **Cmd-K** toggles PlayTools' keymap editor, and keymaps are saved automatically for that game.

PlayTools keeps input settings and keymaps in private storage for each application. The normal PlayCover container, however, is not accessible, and existing external keymaps are not imported. Discord activity and PlayChain stay disabled.

## Module architecture

The iOS module is in `src/modules/ios`, and its detection and preparation run off the Electron main thread. Before an extracted tree is used, its ZIP paths, sizes, duplicate names, special files and entry checksums are checked. Mach-O rewriting needs real header padding and refuses encrypted load commands. Preparation is cached and reused while the source and prepared files are unchanged, and extraction replaces a prepared tree in one atomic step. The native launch uses the common process, network and graphics services.

MacLauncher also includes an ARM64 compatibility adapter, which redirects PlayTools' explicit container file URLs to the app's private home. Some applications assume that UIKit always provides a vendor identifier and crash at startup without one, so when UIKit provides none, the adapter returns a persistent UUID that is stored separately for each game. Existing system identifiers, other URLs and filesystem permissions are unchanged. The adapter's Swift, C and Objective-C sources are in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/package-support/src/modules/ios/native), whose ios-playtools-paths package builds this small library for macOS 12 or later. Normal installation uses the included library.

## Sources and licenses

Upstream projects: [PlayCover](https://github.com/PlayCover/PlayCover), [PlayTools](https://github.com/PlayCover/PlayTools) and the [PlayCover documentation](https://docs.playcover.io/). Both projects are licensed under GPL-3.0. Their binaries are downloaded on demand from the publisher, and Credits links the corresponding source and license information.
