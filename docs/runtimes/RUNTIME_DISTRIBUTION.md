# Runtime distribution

The MacLauncher app contains the launcher and the helpers it uses internally. Game engines and game tools are downloaded separately, each with its own versions, as described in [Downloads and offline use](README.md#downloads-and-offline-use). Engines and tools that need changes to run on macOS come from MacLauncher Builds; the others are downloaded from their publishers.

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) is a companion repository that provides those packages as compiled builds, together with their version history and MacLauncher's patch sets. For each published version it keeps the exact upstream commit, MacLauncher's changes to that code and the build script, and each project has a catalog of its published versions. The launcher reads these catalogs and downloads the compiled packages from their public URLs. The two repositories are independent: playing games needs neither checkout, and building packages needs neither the launcher's repository nor its Electron and React dependencies.

## Distribution policy

MKXP-Z, Adobe Flash Player and the individual visual-novel engines are downloaded, never bundled with the app. MacLauncher's patches are already part of the packages that MacLauncher Builds publishes, so the app carries no fallback copy of these engines and no local compiler is needed.

Each download source has its own version selector, link and **Install** action, so MacLauncher Builds and upstream macOS downloads appear separately. When only MacLauncher Builds supplies Mac binaries, its package page is the main link and the upstream code is a secondary reference. Runtime families that are not compatible with each other use separate subtabs, such as Ren'Py 7 and 8, LÖVE 11 and 12, and the HashLink ABI variants.

### MacLauncher Builds downloads

| Project | Runtime or tool |
| --- | --- |
| ai5 | AI5 SDL2 |
| android | MacLauncher Android: the JVM and ART engines, their adapters and the shared runtime files in one package |
| android-aim | AIM adapter |
| anyps5 | AnyPS5 converter for PS5 executables and the x86-64 macOS system libraries for converted games |
| butterscotch | Butterscotch |
| flash-projector | Universal Adobe Flash Player |
| fna | FNA and its matching .NET and native dependencies |
| gamemaker-opengl-helper | Software OpenGL integration for compatible GameMaker runners |
| gemrb | GemRB |
| gm8-decompiler | GameMaker 8 decompiler |
| hashlink | HashLink ABI variants |
| impacto | Impacto |
| krkrsdl2 | Kirikiri SDL2 with its KAG3 scripts and font |
| mkxpz | MKXP-Z with MacLauncher filename fixes |
| mpv | mpv player with decoded GPU video frames for MacLauncher's graphics presenter |
| npengine | NP Engine |
| nxnative-tools | nxnative native host, package extraction and shader tools |
| onscripter-en | ONScripter-EN |
| onsyuri | ONScripter-Yuri Mac builds |
| opengmk | OpenGMK |
| reminori | ReMinori |
| rlvm-adapter | MacLauncher Cocoa integration library for the upstream RLVM app |
| rpgmaker-decrypter | RPG Maker archive and asset extraction |
| siglus | siglus_rs with its native host |
| sys3-decompiler | System 3 decompiler |
| system3 | System 3 SDL2 |
| vnds-love | VNDS-LOVE interpreter for LÖVE |
| vulkan-kosmickrisp-gles32 | KosmicKrisp GLES 3.2 graphics provider |
| xsys35-decompiler | System 3.5 decompiler |
| xsystem35 | xsystem35 |
| xsystem4 | xsystem4 |

In **Runtimes**, each game type's panel groups its related packages and ABI variants. Packages can contain license texts, native libraries and executables. A package can also take shared libraries from dependency packages that it declares at exact releases.

The RLVM Mac app downloads from its upstream project, and its MacLauncher adapter is a separate MacLauncher Builds package. ScummVM installs from the publisher's disk image or another published Mac archive, which is checked against the publisher's SHA-256 file when one is listed. Installation then signs it locally (ad hoc) so that MacLauncher's graphics integration can load into it, and the installation record holds the checksum of the signed copy, which later checks verify without the network.

Runtimes downloaded from their publishers include NW.js, Ren'Py, Godot, LÖVE, Java, Ruffle, ScummVM, RFVP, Xash3D FWGS, mac32, Mac.apk and compatible official GameMaker tools. Decompilers and asset tools come from the same kinds of source; the [tool table](../tools/README.md#where-tools-appear-in-runtimes) lists each one. Upstream MKXP-Z GitHub Actions builds are a download source separate from the MacLauncher Builds packages.

### Included components

The app selects each included package from its declared version and processor build. The sealed package declaration records the complete file inventory, checksums and permissions; the helper manifest describes its executable or protocol. Included helpers and downloadable packages use the shared package contract for identity, path, processor and payload checks. Explicit version choices retain their declared version.

Python, 7-Zip and evbunpack are included in the app for importing and extracting games. Python and 7-Zip are the upstream macOS binaries at fixed versions, and evbunpack is built from a fixed upstream commit. They are included directly, not through MacLauncher Builds.

The innoextract Mac build is a MacLauncher Builds package that is downloaded rather than included. It is listed in **Runtimes → Tools → Installer reader**, and import and RTP preparation download it when needed.

These MacLauncher Builds packages are included in the app because the launcher uses them directly:

| Project | Purpose |
| --- | --- |
| android-apk-metadata | APK metadata extraction during import |
| android-launcher | Android launcher metadata, argument and input adapters, account integration and APK signature verification |
| android-privacy | Native Android privacy and platform integration |
| catsystem2-kif-crypto | KIF archive cryptography for asset tools |
| ios-playtools-paths | PlayTools storage and path adaptation |
| java-steamworks | Matching Java Steam JNI adapters |
| love-luasteam | Lua and LuaJIT Steam integration |
| mkxpz-config-helper | Per-game MKXP-Z configuration isolation |
| reshade | Core graphics host, FX compiler and shader integration |
| steam-api-helper | Shared Steam compatibility ABI |
| steam-ticket-loader | Steam ticket integration |
| web-renderer-network | Network isolation for browser games |

None of these is a game engine. The launcher chooses their versions and architectures, and the app contains only the builds it needs, not every published version. Launcher scripts and UI are part of the launcher's own source. The Siglus, RLVM, KAG3 and AIM changes ship in their downloaded packages. Kawariki scripts, the launcher's additions to them and the RPG Maker NW.js files are included with the launcher and need no separate installation. VNDS-LOVE is installed together with its selected LÖVE version when the game is played.

## Builds catalogs and installation

MacLauncher Builds publishes one catalog per project at `catalogs/<project>.json`, in version 2 of the catalog format. A catalog records exact package versions, architecture support, the minimum macOS version, release tags that never move, asset names, byte lengths and SHA-256 checksums. Tags have the form `<project>/v<version>/<arch>`, and each release contains the compiled archive for that project. One version can have a separate package for each architecture, `arm64`, `x64` or `universal`, and the catalog lists all of them. The Builds **Runtime build** workflow compiles each architecture's package on a GitHub-hosted Mac and adds a signed build attestation for the archive; the [Builds release guide](https://github.com/procrastinine/maclauncher-builds/blob/main/docs/RELEASES.md#github-builds) describes it.

### Package versions

A package based on a tagged upstream version is versioned `<upstream-version>-MCLvN`, where the revision starts at one for each new upstream version. A package based on an upstream that has only commits is versioned `MCLvN-MMDD`; its revision number increases across commits and calendar years, and the date comes from the selected upstream commit. Package metadata keeps the exact commit and full date. Components that MacLauncher itself develops use their own version. The package revision is separate from the version embedded in the upstream program, which stays unchanged.

A project can list several versions, including several revisions of one upstream version. Each is a separate download and installation, so installing a later revision leaves earlier ones installed. Every compatible version appears in its source's version selector, and every installed version has its own **Uninstall** and **Set default** actions. Play chooses among them as described in [Versions](README.md#versions).

### Catalog records

The [package index](https://procrastinine.github.io/maclauncher-builds/) lists the published downloads and their compatibility. The launcher has no built-in download list; it reads a project's catalog only when versions are requested, and it checks every record. Each record names the upstream commit it was built from and lists the capabilities its module reads, such as a native API, a feature list or the supported data versions. The module matches games against those capabilities, so an unmodified upstream release is never used where a game needs MacLauncher's changes.

Each catalog record is checked on its own. A record that the launcher cannot install stays in the version selector with the reason, and the project's other versions remain available. A record reads "Requires a newer MacLauncher." when it has a later record schema, a `launcherContract` above the one the launcher implements for that project, or an architecture the launcher does not know.

`launcherContract` is a positive integer that defaults to 1 on a catalog record. MacLauncher supports contracts 1 and 2. Packages that store file aliases or depend on shared packages declare contract 2, and earlier launchers keep offering the compatible older records. A project raises the contract only when a package depends on launcher behavior that earlier launchers lack. New record fields need no new `launcherContract` value, and launchers that do not use them ignore them. A record for a runtime built from an upstream project names that repository and commit in `source`, and its `capabilities` object lists the facts its module uses to match games. A later record that names its source can be installed without a launcher update, and a record that names no source commit is listed with that reason.

### Installation

Installation checks the downloaded archive's SHA-256 against the catalog and extracts it into a temporary directory with safe relative paths. A managed package does not need to match the file lists or per-file byte records in its manifests. The native code signatures, CPU architectures and macOS requirement are checked before the installation moves into place in one step. Cancelling removes the temporary directory and leaves installed versions and compatible local registrations as they were.

The same installation consent covers a package's declared dependencies. Dependencies are installed first, each matched by project, release and archive SHA-256, and each keeps its own sealed inventory. A package archive stores identical files once and records the other paths as aliases. Installation creates data aliases as APFS clones, or as ordinary copies on file systems without cloning. A Mach-O alias is a strict relative symbolic link to the one stored copy of the image, so dyld loads that image only once. A Mach-O alias in another directory is accepted only when its load commands resolve identically from both locations. Aliases into a dependency are relative symbolic links to its exact installed files, verified against that dependency's sealed inventory. Libraries without path aliases are found through the library-path environment that the module sets. A shared dependency stays installed while any installed package refers to it, directly or through another dependency.

Packages included in the app use the same declarations. The app keeps its package lock and each package's outer declaration, unchanged, at `native-runtimes/.declarations/<archiveSHA>.json`. The outer declaration describes the stored files and aliases, while the runtime and helper manifests inside the package keep their logical paths, the paths that files have once aliases are in place. Included-package verification checks the stored layout before installation and the complete logical layout afterward, and it rejects undeclared files and links.

Within each backend process, unchanged files can reuse a verified digest. Reuse requires the same file identity, size, permissions and precise modification and change times. Changed files and files with coarse or uncertain change times are read again. These bounded caches hold no file contents, and no verification record is saved. Inventory, alias, dependency and processor checks run on every payload verification.

MKXP-Z can reuse an exact runtime resolution during one launch preparation. Runtime mutation, mutable preparation, process binding and release clear that result.

Godot, LÖVE and NW.js listings fully validate each app bundle on first use and whenever its file facts change. Repeated queries reuse that status only while the bundle entry, directories and symbolic-link targets retain their precise identities. Coarse or uncertain facts require another full check. The selected managed bundle receives full validation before launch. Parsed property lists and LÖVE version and processor facts use the same process-local cache mechanism and are refreshed when their file identity changes. Within one launch preparation, repeated installed-version listings can reuse their results. Runtime mutation, process binding and release clear those results. Custom runtimes retain their own validation and executable paths.

Minimum macOS versions in catalogs are lower bounds, so a requirement of 27.0 also accepts later compatible releases such as 27.1 and 27.2. Each record states its architecture and game ABI explicitly, including Intel builds that need Rosetta on Apple Silicon. [System requirements](SYSTEM_REQUIREMENTS.md) lists the requirements of each runtime.

Android common, ART and AIM are separate packages. Android SDK system images are a separate download that asks for its own confirmation, and Java is downloaded when it is required. Mac.apk uses its publisher's releases. Each Android adapter is built against a matching set of framework, JNI and native sources.

## Application assembly

MacLauncher is built as two separate apps, one for Macs with Apple Silicon and one for Macs with an Intel processor. [`build/runtime-packages.json`](../../build/runtime-packages.json) selects the helper packages that each app includes: every package record lists the app architectures that include it, and an app contains only packages built for its architecture or as universal binaries. A helper that has no Intel build, such as the Android and iOS helpers, is left out of the Intel app. Modules declare the helpers they use. On an Intel Mac, a game whose module needs a helper that the Intel app lacks cannot be played, and the library shows that it requires a Mac with Apple Silicon. Game engines and external tools download separately, and the CI workflow that builds each app downloads the exact selected helper packages for its architecture first.

The selection is made from the published catalogs with a lock command, which covers both app architectures. It has no effect on the download lists in **Runtimes**:

```sh
node scripts/runtime-packages.cjs lock <catalog-directory>
```

`scripts/distribution-model.cjs` derives the list of resources to include from module declarations. `scripts/runtime-content.cjs` keeps test runners, fixtures and generated test outputs out of the development renderer server and out of application packages, and embedded source archives follow the same rule.

Before signing, native staging applies each module's rules for which files ship. Executables, dependency libraries, runtime resources and license notices go into the package, and the scripts that build it stay in the source repository.

```sh
pnpm package:mac --arm64
```

Each command builds one architecture. The Intel app uses `--x64`, and it needs the Intel build of the embedded Python, which `node scripts/setup-python-runtime.mjs --arch x64` installs; `--arch arm64` installs the pinned Apple Silicon publisher build. Packaging fails when the embedded Python does not match the app's architecture.

The launcher's release assets are `MacLauncher.app.zip` for Apple Silicon and `MacLauncher-Intel.app.zip` for Intel. [macOS app builds](../development/CI.md) describes the application workflow.

## Source and licenses

Each MacLauncher Builds release tag points to the commit that contains everything the package was built from: the exact upstream commits, MacLauncher's patches and the build scripts. The source is available at that commit on GitHub, so a release holds only the compiled package, with no separate source archive or manifest.

Catalog metadata and the manifests inside packages are used for installation and integrity checks. License texts are ordinary payload files in `licenses/`, covered by the same file inventory and checksums as other package files. Each distinct text is stored once; `licenses/components.txt` names the text used by each component. Build scripts warn and continue when a candidate license source cannot be copied. Android system images and proprietary developer SDKs follow their own acquisition and redistribution terms.

Upstream source is used at an exact commit and never edited, and MacLauncher's changes are applied during the build. A working publisher binary is used as it is when a rebuild would add no needed feature or compatibility fix. The build scripts are in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds).

### One stored copy in the app

When the app is assembled, identical data files from included packages, publisher tools, Python and unpacked application files are stored once. Mach-O images stay at their original locations, so their loader-relative paths still resolve. When a set of identical files includes one in `native-runtimes`, the stored copy stays inside that folder's signing boundary. One regular file holds the bytes, and the other paths in the bundle are relative symbolic links within the same app. The stored copy keeps the required executable bits. Each logical path is still verified against its original source or sealed package inventory, and packaging rejects data stored twice or a link that leads outside the app. License notices, text sources, artwork and Flash files always keep their own copies.

Compiled application inputs are unpacked from the ASAR archive when necessary, so that this sharing covers them too. Android's apksig JAR is unpacked once, and Java uses that file in the app bundle directly; package inspection writes no second copy to launcher data.
