# Runtime release catalogs

A release catalog is the list of versions that a runtime manager can download. Catalogs are loaded only on request and then cached, so the version lists in **Runtimes** work offline. This page describes where each catalog comes from, how refresh and caching behave, and how catalog entries relate to installed versions. The [runtime system](README.md) describes version selection, runtime managers and [when MacLauncher downloads](README.md#downloads-and-offline-use).

## Loading versions

The list of available releases stays empty until a query has run or a saved catalog exists. Queries run on Refresh, and also on a Play or tool action that needs exact release metadata. Refresh only updates the list: it installs nothing and keeps the selected defaults and per-game versions. Whatever the catalog contains, installed versions and versions resolved for a game stay selectable.

Each download source also shows a short description of what it publishes. While a source has no listed versions, it offers **Load versions**, and this action stays available after a failed request. When a query succeeds but finds nothing, the source reports that it has no downloadable versions.

How much one action loads depends on the source. NW.js, Java, Godot and Ren'Py load their complete release lists, up to their limits, with a single **Reload** action. Their manager states set `supportsLatestOnly: false`, so the UI offers no separate **All versions** action for them. Catalogs of GitHub Actions builds whose history spans many pages (MKXP-Z upstream builds, LÖVE nightlies and Butterscotch) have two controls instead: the refresh control runs a short scan that lists the newest successful build, and **All versions** loads the longer history.

## Official release indexes

NW.js, Java, Godot and Ren'Py read the release indexes that their publishers maintain:

| Manager | Source | Ordinary refresh | Limit |
| --- | --- | --- | --- |
| NW.js | [Official version index](https://nwjs.io/versions.json), with fallbacks to the official download index | Exact stable `major.minor.patch` releases, newest first | 500 versions |
| Java | [Adoptium API](https://api.adoptium.net/swagger-ui/) | macOS HotSpot JDK GA releases of each LTS line (8, 11, 17, 21 and 25) in its own section, and of every other feature release Adoptium lists, including later ones, in the **Other** section; Apple silicon and Intel assets are merged by exact version | 5 pages × 20 releases per architecture; the low-level pager allows at most 10 pages |
| Godot | [Official archive](https://godotengine.org/download/archive/) | Exact archive releases, including stable, RC, beta, alpha and development builds, newest first | 500 versions |
| Ren'Py | [Official download index](https://www.renpy.org/dl/), checked against the [current release](https://www.renpy.org/latest.html) or the [Python 2 release](https://www.renpy.org/latest-7.html) | All numeric releases of the selected group, up to its latest stable version: Ren'Py 7 and earlier, or Ren'Py 8 and every later major | 500 versions per group |

Whichever index a version comes from, installation and launch check the selected package's CPU and macOS requirements.

### Java

Java comes from Adoptium, whose API returns its releases in pages. Adoptium documents a maximum `page_size` of **20** in its [OpenAPI specification](https://api.adoptium.net/openapi), and larger values can return a successful but shortened response. The Java pager therefore requests 20 releases at a time and moves on after each full page. When the final page returns an empty list, HTTP 204 or HTTP 404, the pager keeps the earlier results; a response that is not an array, however, is rejected. A release whose metadata cannot be read is skipped, and an answer that lists no Mac build for either CPU leaves the cached list unchanged.

Installation verifies each package against the SHA-256 that Adoptium publishes with it and extracts the package according to its published name. Vineflower, the Java decompiler, is not an Adoptium package: its JARs come from GitHub releases and are checked as described under [Integrity](#integrity).

Adoptium's releases are grouped into feature-release lines, and each long-term support (LTS) line has its own section. The **Other** section lists the feature releases outside the LTS lines, newest first, and it loads a line's builds when that line is selected. A game that needs a line newer than the newest LTS line installs from this section.

Java 8 has no Apple silicon asset in the catalog, so it can use an Intel runtime through Rosetta. The manager keeps the architecture choice and reports availability for each exact version.

Version labels use Adoptium's exact `openjdk_version`, including a fourth patch component. Upstream `17.0.20.1+1`, for example, stays `17.0.20.1+1` and does not become `17.0.20+101`, even though Adoptium also publishes that encoded SemVer value. Catalog lookup keeps the aliases that the same release metadata provides, so a SemVer key stored earlier still selects its package, while new installations use the canonical OpenJDK version. Existing installation directories and explicit selections keep their original keys. A missing manual per-game version stays missing. A recommended or default Java patch can use a ready installed release of the same JVM major line and required CPU variant.

### NW.js

The NW.js index describes the files and flavors of each version. From its `files` and `flavors` fields, MacLauncher reports whether a version's SDK build runs natively, needs Rosetta or is unavailable. Versions without an SDK flavor or a usable Mac architecture stay visible in the history but are left out of `installableVersions`, and entries without architecture metadata show their availability as unknown. A universal `osx-universal` build serves both CPUs.

Installation reads the version folder's `SHASUMS256.txt`, which gives the SDK archive's current name and format and the SHA-256 the download must match. A version folder without that list uses the listed `nwjs-sdk-v<version>-<platform>.zip` archive. Wherever the archive places `nwjs.app`, installation finds it. The catalog states no minimum macOS version, so installation reads it from the downloaded executable and frameworks and stops only when this Mac runs an older macOS.

Some NW.js games also use [Greenworks](https://github.com/greenheartgames/greenworks/releases), a native Node bridge for Steam integration. Its catalog lists one row per NW.js version from the Greenworks releases, and each row is the Mac archive named after that NW.js version in the newest Greenworks release that serves it.

### Godot and Ren'Py

Godot installs the macOS **Standard** or **.NET** bundle, depending on the selected variant and the game's scripting requirements. Its archive also lists older versions that have no .NET package. A version's download links can lead to the official download service or straight to an archive, which can be a ZIP, a tar archive or a disk image. Export templates, debug symbols and checksum files are not treated as editor downloads. Because the download service publishes no checksum, an archive from it has its SHA-256 recorded at installation; a release read from GitHub, by contrast, is checked against the checksum that GitHub lists.

Ren'Py keeps separate catalogs for Python 2 and Python 3: the Ren'Py 7 group holds 7 and earlier, and the Ren'Py 8 group holds 8 and every later major. Each group includes the official latest stable version even when the directory index has not been updated yet. The Python 2 group also keeps historical releases, including early ones without the SDK DMG that the current installer expects, and historical entries without a matching Mac package stay visible with installation disabled.

A Ren'Py version folder can be reached through a relative or an absolute link. The SDK in it is usually named `renpy-<version>-sdk.dmg`, or `renpy-<version>-sdk.zip` for game patching. When a folder no longer holds it under that name, installation looks in the folder's listing for another SDK disk image or archive of the same version, and it finds the SDK wherever the download places it. If the folder has a `checksums.txt`, that file gives the SHA-256 the SDK must match.

### Vulkan drivers

The two Vulkan drivers, MoltenVK and KosmicKrisp, have catalogs of their own. MoltenVK lists every [MoltenVK release](https://github.com/KhronosGroup/MoltenVK/releases). For installation, it uses the release's `MoltenVK-macos.tar`, a renamed archive whose name has a Mac or universal word, or otherwise the all-platform package. A release with none of these stays listed and shows that reason.

KosmicKrisp lists the release folders of [LWJGL's build listing](https://www.lwjgl.org/browse/release) that contain `macosx/arm64/libvulkan_kosmickrisp.dylib`. The build host states the library's size, and the `.git` file beside the library names the Mesa revision it was built from. The library is checked against the SHA-256 that the host states in its response headers. KosmicKrisp is loaded through the Khronos Vulkan loader, so installation also reads Homebrew's `vulkan-loader` formula and downloads one of its bottles, Homebrew's prebuilt binary packages. It takes the Apple Silicon bottle built for the newest macOS release that is not later than the running one, or another Apple Silicon bottle when the formula offers none of those, and checks it against the formula's SHA-256.

Neither catalog states a minimum macOS version; installation reads it from the downloaded libraries.

## Caching

MacLauncher caches a successful catalog result in the process for six hours, and `force: true` bypasses that cache. After a failed request, the last valid rows and the time of the last successful query are kept, and the request can be retried immediately.

When a refresh of a download list fails, the list shows **Last refresh failed** with the recorded date of the failure. Older cached failures have no such date and show **date unavailable**, and the last successful query time is not used in its place. Before error text and installation reasons are cached or displayed, any user names and passwords in their URLs are removed. Errors that were cached earlier are cleaned in the same way when they are read, and the profile is not rewritten merely to remove old error text.

Backend callers of ordinary release catalogs can request `latestOnly: true`. Leaving it out requests the full list, which is what the runtime panels always request. GitHub Actions catalogs work the other way round: a missing `latestOnly` means the short newest-build scan, and `latestOnly: false` requests the longer history, which is what the **All versions** button sends. Because the cache records which mode a result came from, a short result never answers a full refresh. A full refresh that arrives during a short request waits for it and then fetches the history, and concurrent requests for the same mode share one pending request.

The latest available version comes from the remote catalog, while the selected default and the latest installed version are tracked separately.

## GitHub catalogs

### Sikarugir

Sikarugir publishes two kinds of release on GitHub: Wine engines, and Templates, the packages of support libraries that go with them. On request, MacLauncher refreshes both the Engines and the Template releases, reading at most five pages per repository. An engine archive is named after its Wine version, with any `WS` wrapper generation and an optional platform word, and a support archive is named after its Template version, 1.0.19 or later. Either can be a `.tar.xz`, `.tar.gz`, `.tar.bz2`, `.tar` or `.zip` archive, and archives for other platforms and debug symbols are ignored. When one release offers several archives for the same version, MacLauncher prefers the newest `WS` wrapper generation, then a name without a variant word such as `-battle.net`, then the `.tar.xz` archive.

Every engine is paired with the newest support archive. A Sikarugir version therefore combines four identities: the Wine version, the engine identity, the Template version and the Template identity. The rolling `v1.0` release tag, on the other hand, does not identify a Wine version. Downloads are checked against the SHA-256 and size that GitHub lists. An asset that GitHub lists without a SHA-256 is identified by its download address, asset ID and size, and installation records its SHA-256. The minimum macOS version comes from the installed engine and support libraries, and installed versions stay selectable after a refresh.

### GitHub releases

Several runtimes are published as GitHub releases: Ruffle, LÖVE stable releases, ONScripter-Yuri, Ikemen GO, HashLink and Xash3D FWGS. Their catalogs read these releases through the shared helpers, which stop after a set number of pages. For Ruffle, the ordinary **Reload** lists all releases by default.

The LÖVE nightly section and MKXP-Z's upstream source read GitHub Actions runs instead, through GitHub's public API, which needs neither the GitHub CLI nor a GitHub account. Their refresh control lists the newest successful build, and **All versions** lists the builds from the 20 most recent successful runs. Artifacts download through [nightly.link](https://nightly.link/), also without a sign-in, and each one is checked against the checksum that GitHub publishes for it. A run whose artifact list cannot be read, or whose artifacts have expired, is skipped while the other runs stay listed, and an installed build keeps working after its artifact expires. A LÖVE nightly label includes the upstream version from `src/common/version.h` at the exact workflow commit, together with that commit and its date. A branch name such as `main` is never shown as a runtime version.

LÖVE and Ruffle recognize a Mac release under its current name, in another archive format or with a CPU or platform word added, and they leave out iOS, source, debug and symbol archives.

HashLink distinguishes installable Mac builds from source releases. ONScripter-Yuri lists any release tag that reads as a version, and its Mac executables are published as plain files or archives. A processor word in a file name lists the file for that processor, and a name without one serves both.

### Shared helpers and limits

The catalogs of native engines are built on shared helpers. `github-runtime-catalog.js` discovers releases and tags, and `runtime-catalog.js` stores the cache on disk atomically. Each engine only adds callbacks that map upstream metadata to versions, exact source commits and the assets that run on the host.

Engine catalogs also choose Mac downloads through a shared helper, `release-files.js`. A download qualifies when its name has a Mac platform word or it is a disk image, and when its format is supported: ZIP, a plain, gzip, xz or bzip2 tar archive, or a disk image. The publisher's current file name is preferred. Files for other systems, debug symbols and sources are ignored, and a processor word in a name lists the download for that processor only.

After extraction, the expected executable, app bundle or framework is taken from its known path. When a release moves it, a search of the first three folder levels finds it, skipping archive metadata, hidden entries, links and the contents of app bundles. Minimum macOS versions come from the downloaded executables and app bundles. If that minimum stops an installation on an older Mac, the cached catalog records it, and when the catalog identifies the file by SHA-256, a refresh keeps the measured minimum for that same checksum. While the minimum is recorded, the version shows its macOS requirement, automatic selection skips it and it is not downloaded again. A replaced file, however, has no recorded minimum until its own download is checked.

An ordinary GitHub release query reads up to five pages of one hundred entries. Through the shared helpers, a module can select up to twenty pages and two thousand cached entries without changing the defaults of other managers. Impacto, for example, uses ten pages and one thousand entries so that older source releases stay listed; the installable Mac packages for Impacto's Windows data profile come from MacLauncher Builds.

GitHub's numeric pagination links are followed only when they stay on the same API host and the configured repository path. Annotated tags are resolved to their commits.

### Commit snapshots

Projects without releases can use a shared commit provider, which lists commits up to a fixed limit. Each entry is identified by its exact commit and is not presented as a release. The default commit mapper uses `git-<40-character commit>` as the version and keeps the default branch's history order. Each version is labelled with the commit date and short commit, the first entry is marked HEAD, and the commit subject is kept as separate metadata.

Python tools that are installed from source can keep each provider's catalog in a separate `sourceId` cache. For these tools, Refresh fetches metadata only, and Install downloads the selected commit's ZIP archive. The installation record then stores the full commit, its `committedAt` time (separate from `installedAt`), the archive SHA-256 and byte count measured at download, and a hash for each file. This recorded archive hash is not a checksum published by the upstream project.

Each of these Python tools can declare `archiveLimits` for archive size, expanded size and entry count, while other tools use the defaults of 32 MiB, 64 MiB and 2,000 entries. Download, extraction and the installation record check all use the same limits.

## Refresh results and installed versions

Available download lists come from explicit discovery or its cache, and a successful refresh replaces that source's remote list. Version numbers with and without a `v` prefix share one row, with the upstream tag kept as separate metadata. A Mac build of an exact commit and the published release of that version also share one row, unless the build and the release name different commits.

Changed or removed release metadata never points an installed binary at a different release, because the installation record stores its original catalog entry, source revision and hashes. Older installed versions stay usable and removable, but they are not offered as downloads once the catalog no longer lists them.

A saved default stays selected after Refresh. Play uses it while it is installed or listed, or while no list has been loaded. When upstream has removed it and it is not installed, Play uses the newest listed or installed version instead.

## Integrity

When a publisher lists a checksum or a size for a file, the download is checked against it. GitHub lists a SHA-256 checksum for Actions artifacts and most release assets, although older release assets can lack one. A file without a publisher checksum is downloaded over HTTPS from the location the publisher lists, and it passes the same structural checks as any other package: it must be a readable archive with the expected files and executables. Its SHA-256 is then recorded at installation. Such a recorded hash identifies the installed files, but it is not a checksum from the publisher. Native architecture is checked after extraction.

Source-only releases and old assets without a compatible Mac package show why they cannot be installed. The selected version's reason takes precedence over general setup help, both in the installation help and in the disabled button's tooltip.
