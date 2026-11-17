# Runtime distribution

This page covers where MacLauncher's engines, tools and helpers come from, which of them ship inside the app, and how their packages are versioned and installed. MacLauncher keeps game engines and game tools out of the app itself. The app contains the launcher and the helpers that the launcher uses internally, while engines and tools are downloaded separately, each with its own versions, as described in [Downloads and offline use](README.md#downloads-and-offline-use). An engine or tool that needs changes to run on macOS is downloaded from MacLauncher Builds, and any other comes from its publisher.

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) is a companion repository that provides those changed engines and tools as compiled packages, together with their version history and MacLauncher's patch sets. For each published version, it keeps the exact upstream commit, MacLauncher's changes to that code and the build script, and each project there has a catalog of its published versions. The launcher reads these catalogs and downloads the compiled packages from their public URLs. Neither repository depends on the other: playing games needs neither checkout, and building packages needs neither the launcher's repository nor its Electron and React dependencies.

## Distribution policy

Some engines are always downloaded and never included in the app: MKXP-Z, Adobe Flash Player and the individual visual-novel engines. MacLauncher's patches are already part of the packages that MacLauncher Builds publishes, so the app carries no fallback copy of these engines and no local compiler is needed.

**Runtimes** shows MacLauncher Builds packages and upstream macOS downloads separately, since each download source has its own version selector, link and **Install** action. When only MacLauncher Builds offers Mac binaries, its package page is the main link and the upstream code is a secondary reference. Runtime families that are not compatible with each other, such as Ren'Py 7 and 8, LÖVE 11 and 12 and the HashLink ABI variants, use separate subtabs.

### MacLauncher Builds downloads

These projects are published as MacLauncher Builds downloads:

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
| maclauncher-kosmickrisp | MacLauncher KosmicKrisp Vulkan driver |
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
| xsys35-decompiler | System 3.5 decompiler |
| xsystem35 | xsystem35 |
| xsystem4 | xsystem4 |

In **Runtimes**, each game type's panel groups its related packages and ABI variants. A package can contain license texts, native libraries and executables, and it can also take shared libraries from dependency packages that it declares at exact releases.

The RLVM Mac app is downloaded from its upstream project, while its MacLauncher adapter is a separate MacLauncher Builds package. ScummVM is installed from the publisher's disk image or another published Mac archive, which is checked against the publisher's SHA-256 file when one is listed. Installation then signs it locally (ad hoc) so that MacLauncher's graphics integration can load into it, and the installation record keeps the installed version and source for offline use.

Other runtimes are downloaded directly from their publishers, among them NW.js, Ren'Py, Godot, LÖVE, Java, Ruffle, ScummVM, RFVP, Xash3D FWGS, UZDoom, Raze, DREAMM, mac32, Mac.apk and compatible official GameMaker tools. Decompilers and asset tools come from the same kinds of source, and the [tool table](../tools/README.md#where-tools-appear-in-runtimes) lists each one. MKXP-Z has both kinds: besides its MacLauncher Builds packages, the upstream GitHub Actions builds are offered as a separate download source.

### Included components

A few components are part of the app instead of being downloaded. Each included package is selected by its declared version and processor build and comes with two descriptions: a package declaration records its complete file list, checksums and permissions, and a helper manifest describes the helper's executable or protocol. Included helpers must match the app's package list, [`build/runtime-packages.json`](../../build/runtime-packages.json), exactly; this file records which package versions the app includes. Downloadable packages are instead checked by the archive checksum in the catalog, safe paths and their actual native requirements. Explicit version choices keep their declared version.

For importing and extracting games, the app includes Python, 7-Zip and evbunpack directly rather than through MacLauncher Builds. Python and 7-Zip are the upstream macOS binaries at fixed versions, and evbunpack is built from a fixed upstream commit.

innoextract, which reads installers, is handled differently: its Mac build is a MacLauncher Builds package that is downloaded rather than included. It is listed in **Runtimes → Tools → Installer reader**, and import and RTP preparation download it when needed.

The launcher uses the following MacLauncher Builds packages directly, so they are included in the app:

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

None of these is a game engine. The launcher chooses their versions and architectures, and the app contains only the builds it needs out of all the published versions. Launcher scripts and UI are part of the launcher's own source, whereas the Siglus, RLVM, KAG3 and AIM changes ship in their downloaded packages. Kawariki scripts, the launcher's additions to them and the RPG Maker NW.js files are included with the launcher and need no separate installation. VNDS-LOVE is installed together with its selected LÖVE version when the game is played.

## Builds catalogs and installation

The launcher learns what MacLauncher Builds offers from its catalogs. Each project has one catalog at `catalogs/<project>.json`, in version 2 of the catalog format, which records exact package versions, architecture support, the minimum macOS version, release tags that never move, asset names, byte lengths and SHA-256 checksums. A release tag has the form `<project>/v<version>/<arch>`, and each release contains the compiled archive for that project. One version can have a separate package for each architecture (`arm64`, `x64` or `universal`), and the catalog lists all of them. The packages are built on GitHub, where the Builds **Runtime build** workflow compiles each architecture's package on a GitHub-hosted Mac and adds a signed GitHub build attestation, a record of the workflow run that produced the archive, as the [Builds release guide](https://github.com/procrastinine/maclauncher-builds/blob/main/docs/RELEASES.md#github-builds) describes.

### Package versions

A package version names both the upstream version it is based on and MacLauncher's revision of it. When the upstream project has tagged versions, the package is versioned `<upstream-version>-MCLvN`, and the revision starts at one for each new upstream version. When the upstream has only commits, the package is versioned `MCLvN-MMDD`: its revision number keeps increasing across commits and calendar years, and the date comes from the selected upstream commit. In both cases, the package metadata keeps the exact commit and full date. Components that MacLauncher itself develops use their own version. The package revision is also separate from the version embedded in the upstream program, which stays unchanged.

A project can list several versions, including several revisions of one upstream version. Each of them is a separate download and installation, so installing a later revision leaves earlier ones installed. Every compatible version appears in its source's version selector, every installed version has its own **Uninstall** action, and each one is a choice in the **Default** menu. Play chooses among them as described in [Versions](README.md#versions).

### Catalog records

The [package index](https://procrastinine.github.io/maclauncher-builds/) lists every package with its latest version and that version's downloads, and each package's own page lists its published versions and what changed in each. The launcher itself has no built-in download list. It reads a project's catalog only when versions are requested, and it checks every record in it. A record can describe the source it was built from and the capabilities that modules read, such as a native API, a feature list or the supported data versions. The source description is informational and is not required for installation. Modules do match games against the capabilities, however, so an unmodified upstream release is never used where a game needs MacLauncher's changes.

Each catalog record is read on its own, so added fields, later schema or `launcherContract` numbers and changes to the source description need no launcher update. A download is identified by its archive URL and SHA-256, while the actual CPU and macOS requirements decide whether its native code can run. A feature that calls a particular runtime API checks that API separately. When a record leaves the catalog, its installed versions remain usable.

### Installation

Installation first checks the downloaded archive's SHA-256 against the catalog and extracts the archive into a temporary directory, using only safe relative paths. A downloaded package can add files and fields, so its catalog record, its outer declaration (which describes the stored files) and its inner manifest do not have to be equal. Likewise, schema numbers, source labels and recorded per-file checksums do not limit which MacLauncher versions can install it. Its native code signatures, CPU architectures and macOS requirement are checked before the installation moves into place in one step. Cancelling removes the temporary directory and leaves installed versions and compatible local registrations as they were.

A package can depend on other packages, which the downloaded package declares itself. Consent for the package also covers its declared dependencies, and each dependency archive is verified against its catalog SHA-256 before it is installed. A shared dependency stays installed as long as any installed package refers to it, directly or through another dependency.

To save space, a package archive stores identical files only once and records their other paths as aliases. At installation, data aliases become APFS clones, or ordinary copies on file systems without cloning. A Mach-O alias, on the other hand, becomes a strict relative symbolic link to the one stored copy of the image, so dyld loads that image only once. Every alias must stay within the package or a declared dependency, and included packages are also held to exact checks of their aliases and complete file lists. Libraries without path aliases are found through the library-path environment that the module sets.

Packages included in the app use the same declarations. The app keeps its package list and each package's outer declaration, unchanged, at `native-runtimes/.declarations/<archiveSHA>.json`. The outer declaration describes the files as they are stored, with their aliases. The runtime and helper manifests inside the package, by contrast, keep their logical paths, which are the paths that files have once the aliases are in place. Verification of an included package therefore checks the stored layout before installation and the complete logical layout afterward, and it rejects undeclared files and links.

Within each backend process, the verification of included packages can reuse a checksum that it has already verified. Reuse requires the same device and inode numbers, size and permissions and the same precise modification and change times, so changed files, and files whose change times are coarse or uncertain, are read again. The checksums are kept in size-limited caches that hold no file contents, and no verification record is saved. Every verification of an included package's files still applies the exact file-list, alias, dependency and processor checks of included packages.

During one launch preparation, MKXP-Z can reuse the result of resolving its exact runtime. That result is cleared when a runtime changes, when a preparation step modifies files, when the game process takes its leases on its runtimes (see [Concurrent runtime use](README.md#concurrent-runtime-use)) and when the launch releases them.

For the Godot, LÖVE and NW.js version lists, each app bundle is fully validated when it is first used and whenever its file metadata changes. Later queries reuse that result only while the bundle entry, its directories and its symbolic-link targets keep the same device and inode numbers, mode, size and precise modification and change times; coarse or uncertain metadata requires another full check. Whatever the cache holds, the selected bundle that MacLauncher installed is fully validated before launch. Parsed property lists and LÖVE's version and processor facts are cached the same way, within the process, and are refreshed when those file attributes change. Within one launch preparation, repeated listings of installed versions can also reuse their results until a runtime changes, the game process takes its leases or the launch releases them. Custom runtimes keep their own validation and executable paths.

Minimum macOS versions in catalogs are lower bounds, so a requirement of 27.0 also accepts later compatible releases such as 27.1 and 27.2. Each record states its architecture and game ABI explicitly, including Intel builds that need Rosetta on Apple Silicon. [System requirements](SYSTEM_REQUIREMENTS.md) lists the requirements of each runtime.

Android needs several separate downloads. Android common, ART and AIM are separate packages, Android SDK system images are a download that asks for its own confirmation, and Java is downloaded when it is required. Mac.apk, by contrast, comes from its publisher's releases. Each Android adapter is built against a matching set of framework, JNI and native sources.

## Application assembly

MacLauncher is built as two separate apps, one for Macs with Apple Silicon and one for Macs with an Intel processor, and each app includes only the helper packages built for it. The packages are selected by the app's package list, `build/runtime-packages.json`. Every package record there lists the app architectures that include it, and an app contains only packages built for its architecture or as universal binaries. A helper that has no Intel build, such as the Android and iOS helpers, is therefore left out of the Intel app. Because modules declare the helpers they use, a game whose module needs a helper that the Intel app lacks cannot be played on an Intel Mac, and the library shows that it requires a Mac with Apple Silicon. The CI workflow that builds each app first downloads the exact selected helper packages for its architecture; game engines and external tools are still downloaded separately.

The `lock` command writes this selection from the published catalogs for both app architectures. It has no effect on the download lists in **Runtimes**:

```sh
node scripts/runtime-packages.cjs lock <catalog-directory>
```

Two scripts decide which of the launcher's own files are used. `scripts/distribution-model.cjs` derives the list of resources to include from module declarations, and `scripts/runtime-content.cjs` keeps test runners, fixtures and generated test outputs out of the development renderer server and out of application packages, including embedded source archives.

Before the app is signed, each module's rules decide which native files are copied into it. Executables, dependency libraries, runtime resources and license notices go into the package, while the scripts that build it stay in the source repository.

```sh
pnpm package:mac --arm64
```

The command builds one architecture at a time. For the Intel app, it takes `--x64` and needs the Intel build of the embedded Python, which `node scripts/setup-python-runtime.mjs --arch x64` installs; `--arch arm64` installs the Apple Silicon publisher build at its fixed version. Packaging fails when the embedded Python does not match the app's architecture.

The launcher's release assets are `MacLauncher.app.zip` for Apple Silicon and `MacLauncher-Intel.app.zip` for Intel. [macOS app builds](../development/CI.md) describes the application workflow.

## Source and licenses

Each MacLauncher Builds release tag points to the commit that contains everything the package was built from: the exact upstream commits, MacLauncher's patches and the build scripts. Since that source is available at the tagged commit on GitHub, a release holds only the compiled package, with no separate source archive or manifest.

License texts are ordinary package files in `licenses/`, so the downloaded archive's checksum covers their bytes, and included packages also keep their exact per-file verification. Each distinct text is stored once, and `licenses/components.txt` names the text that each component uses. When a license file that the build scripts look for cannot be copied, they print a warning and continue. Android system images and proprietary developer SDKs follow their own download and redistribution terms.

Upstream source is used at an exact commit and never edited, because MacLauncher's changes are applied during the build. When a rebuild would add no needed feature or compatibility fix, a working publisher binary is used as it is. The build scripts are in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds).

### One stored copy in the app

The app bundle also stores identical files only once. When the app is assembled, identical data files from included packages, publisher tools, Python and unpacked application files are reduced to one regular file that holds the bytes, and their other paths in the bundle become relative symbolic links within the same app. The stored copy keeps the required executable bits, and if one of the identical files is in `native-runtimes`, the stored copy stays inside that folder's signing boundary. Mach-O images, however, stay at their original locations so that their loader-relative paths still resolve. Each logical path is still verified against its original source or the file list recorded for its package, and packaging rejects data that is stored twice or a link that leads outside the app. License notices, text sources, artwork and Flash files always keep their own copies.

Compiled application inputs are unpacked from the ASAR archive when necessary so that they can share files in the same way. Android's apksig JAR, for example, is unpacked once, and Java uses that file in the app bundle directly, so package inspection writes no second copy to launcher data.
