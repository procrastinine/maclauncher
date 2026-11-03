# Runtime release catalogs

A release catalog is the list of versions that a runtime manager can download. Catalogs are loaded only on request and then cached, so the version lists in **Runtimes** work offline. This page describes where each catalog comes from, how refresh and caching behave, and how catalog entries relate to installed versions. The [runtime system](README.md) describes version selection, runtime managers and [when MacLauncher downloads](README.md#downloads-and-offline-use).

## Loading versions

A list of available releases starts empty and stays empty until a query runs or a saved catalog exists. A query runs on Refresh, or on a Play or tool action that needs exact release metadata. Refresh only updates the list: it installs nothing and keeps the selected defaults and per-game versions. Installed versions and versions resolved for a game stay selectable whatever the catalog contains.

Each download source shows a short description of what it publishes. A source with no listed versions offers **Load versions**, which stays available after a failed request. When a query succeeds but finds nothing, the source reports that it has no downloadable versions.

NW.js, Java, Godot and Ren'Py load their complete release lists, up to their limits, with one **Reload** action. Their manager states set `supportsLatestOnly: false`, and the UI offers no separate **All versions** action for them. GitHub Actions catalogs whose history spans many pages (MKXP-Z upstream builds, LÖVE nightlies and Butterscotch) have two controls instead: the refresh control runs a short scan that lists the newest successful build, and **All versions** loads the longer history.

## Official release indexes

| Manager | Source | Ordinary refresh | Limit |
| --- | --- | --- | --- |
| NW.js | [Official version index](https://nwjs.io/versions.json), with fallbacks to the official download index | Exact stable `major.minor.patch` releases, newest first | 500 versions |
| Java | [Adoptium API](https://api.adoptium.net/swagger-ui/) | macOS HotSpot JDK GA releases of each LTS line (8, 11, 17, 21 and 25) in its own section, and of every other feature release Adoptium lists, including later ones, in the **Other** section; Apple silicon and Intel assets are merged by exact version | 5 pages × 20 releases per architecture; the low-level pager allows at most 10 pages |
| Godot | [Official archive](https://godotengine.org/download/archive/) | Exact archive releases, including stable, RC, beta, alpha and development builds, newest first | 500 versions |
| Ren'Py | [Official download index](https://www.renpy.org/dl/), checked against the [current release](https://www.renpy.org/latest.html) or the [Python 2 release](https://www.renpy.org/latest-7.html) | All numeric releases of the selected group, up to its latest stable version: Ren'Py 7 and earlier, or Ren'Py 8 and every later major | 500 versions per group |

Installation and launch check the selected package's CPU and macOS requirements.

### Java

Adoptium documents a maximum `page_size` of **20** in its [OpenAPI specification](https://api.adoptium.net/openapi), and larger values can return a successful but shortened response. The Java pager therefore requests 20 releases at a time and moves on after each full page. When the final page returns an empty list, HTTP 204 or HTTP 404, it keeps the earlier results. It rejects responses that are not arrays. A release whose metadata cannot be read is skipped, and an answer that lists no Mac build for either CPU leaves the cached list unchanged.

Installation verifies each package against the SHA-256 that Adoptium publishes with it and extracts the package according to its published name. Vineflower JARs come from GitHub releases and are checked as described under [Integrity](#integrity).

The **Other** section lists Adoptium's feature releases outside the LTS lines, newest first, and loads a line's builds when that line is selected. A game that needs a line newer than the newest LTS line installs from this section.

Java 8 has no Apple silicon asset in the catalog and can use an Intel runtime through Rosetta. The manager keeps the architecture choice and reports availability for each exact version.

Java shows Adoptium's exact `openjdk_version`, including a fourth patch component. Upstream `17.0.20.1+1`, for example, stays `17.0.20.1+1` and does not become `17.0.20+101`, even though Adoptium also publishes that encoded SemVer value. Catalog lookup keeps the aliases that the same release metadata supplies, so a SemVer key stored earlier still selects its package; new installations use the canonical OpenJDK version. Existing installation directories and explicit selections keep their original keys. A missing exact installed version stays missing and does not select another release.

### NW.js

NW.js uses the `files` and `flavors` fields of its index to report, for each version, whether an SDK build runs natively, needs Rosetta or is unavailable. Versions without an SDK flavor or a usable Mac architecture stay visible in the history but are left out of `installableVersions`. Entries without architecture metadata show their availability as unknown. A universal `osx-universal` build serves both CPUs.

Installation reads the version folder's `SHASUMS256.txt`, which gives the SDK archive's current name and format and the SHA-256 the download must match. A version folder without that list uses the listed `nwjs-sdk-v<version>-<platform>.zip` archive. Installation finds `nwjs.app` wherever the archive places it. The catalog states no minimum macOS version, so installation reads it from the downloaded executable and frameworks and stops only when this Mac runs an older macOS.

Greenworks lists one row per NW.js version from the [Greenworks releases](https://github.com/greenheartgames/greenworks/releases). Each row is the Mac archive named after that NW.js version in the newest Greenworks release that serves it.

### Godot and Ren'Py

Godot installs the macOS **Standard** or **.NET** bundle according to the selected variant and the game's scripting requirements. Its archive also lists older versions that have no .NET package. A version's download links can lead to the official download service or straight to an archive, which can be a ZIP, a tar archive or a disk image. Export templates, debug symbols and checksum files are not treated as editor downloads. The download service publishes no digest, so an archive from it has its SHA-256 recorded at installation, while a release read from GitHub is checked against GitHub's digest.

Ren'Py keeps separate catalogs for Python 2 and Python 3: the Ren'Py 7 group holds 7 and earlier, and the Ren'Py 8 group holds 8 and every later major. Each includes the official latest stable version even when the directory index has not been updated yet. The Python 2 group keeps historical releases, including early ones without the SDK DMG that the current installer expects. Historical entries without a matching Mac package stay visible with installation disabled. A version folder can be reached through a relative or an absolute link. The SDK is usually named `renpy-<version>-sdk.dmg`, or `renpy-<version>-sdk.zip` for game patching. When a folder no longer holds it under that name, installation looks in the folder's listing for another SDK disk image or archive of the same version, and it finds the SDK wherever the download places it. A version folder's `checksums.txt`, when present, gives the SHA-256 the SDK must match.

### Vulkan drivers

MoltenVK lists every [MoltenVK release](https://github.com/KhronosGroup/MoltenVK/releases). Installation uses the release's `MoltenVK-macos.tar`, a renamed archive whose name has a Mac or universal word, or otherwise the all-platform package. A release with none of these stays listed and shows that reason.

KosmicKrisp lists the release folders of [LWJGL's build listing](https://www.lwjgl.org/browse/release) that contain `macosx/arm64/libvulkan_kosmickrisp.dylib`. The build host states the library's size, and the `.git` file beside the library names the Mesa revision it was built from. The library is checked against the SHA-256 that the host states in its response headers. Installation also reads Homebrew's `vulkan-loader` formula and downloads the Apple Silicon bottle built for the newest macOS release that is not later than the running one, or another Apple Silicon bottle when the formula offers none of those. The bottle is checked against the formula's SHA-256.

Neither catalog states a minimum macOS version; installation reads it from the downloaded libraries.

## Caching

A successful catalog result is cached in the process for six hours, and `force: true` bypasses that cache. A failed request keeps the last valid rows and the time of the last successful query, and it can be retried immediately.

A failed download-list refresh appears as **Last refresh failed**, with its recorded failure date. Older cached failures without that date say **date unavailable**; the last successful query time is not used as a failure date. URL user names and passwords are removed from error text and installation reasons before caching or display. Existing cached errors are sanitized when read, without rewriting the profile merely to remove old error text.

For ordinary release catalogs, backend callers can request `latestOnly: true`. Leaving it out requests the full list, and the runtime panels always request the full list. GitHub Actions catalogs treat a missing `latestOnly` as the short newest-build scan, and `latestOnly: false` requests the longer history, which is what the **All versions** button sends. The cache records which mode a result came from, so a short result never answers a full refresh. A full refresh that arrives during a short request waits for it and then fetches the history. Concurrent requests for the same mode share one pending request.

The latest available version comes from the remote catalog. The selected default and the latest installed version are tracked separately.

## GitHub catalogs

### Sikarugir

Sikarugir refreshes the publisher's Engines and Template releases on request, reading at most five pages per repository. An engine archive is named after its Wine version, with any `WS` wrapper generation and an optional platform word. A support archive is named after its Template version, 1.0.19 or later. Either can be a `.tar.xz`, `.tar.gz`, `.tar.bz2`, `.tar` or `.zip` archive, and archives for other platforms and debug symbols are ignored. When one release offers several archives for the same version, MacLauncher prefers the newest `WS` wrapper generation, then a name without a variant word such as `-battle.net`, then the `.tar.xz` archive.

Every engine is paired with the newest support archive. A Sikarugir version combines the Wine version, the engine identity, the Template version and the Template identity. The rolling `v1.0` release tag does not identify a Wine version. Downloads are checked against the SHA-256 and size that GitHub lists. An asset that GitHub lists without a SHA-256 is identified by its download address, asset ID and size, and installation records its SHA-256. The minimum macOS version comes from the installed engine and support libraries. Installed versions stay selectable after a refresh.

### GitHub releases

Ruffle, LÖVE stable releases, ONScripter-Yuri, Ikemen GO, HashLink and Xash3D FWGS read GitHub releases through the shared helpers, which stop after a set number of pages. Ruffle's ordinary **Reload** lists all releases by default.

The LÖVE nightly section and MKXP-Z's upstream source read GitHub Actions runs through GitHub's public API, which needs neither the GitHub CLI nor a GitHub account. The refresh control lists the newest successful build, and **All versions** lists the builds from the 20 most recent successful runs. Artifacts download through [nightly.link](https://nightly.link/), also without a sign-in, and are checked against the digest GitHub publishes for each one. A run whose artifact list cannot be read, or whose artifacts have expired, is skipped while the other runs stay listed, and an installed build keeps working after its artifact expires. A LÖVE nightly label includes the upstream version from `src/common/version.h` at the exact workflow commit, together with that commit and its date. A branch name such as `main` is never shown as a runtime version.

LÖVE and Ruffle recognize a Mac release under its current name, in another archive format or with a CPU or platform word added, and leave out iOS, source, debug and symbol archives.

HashLink distinguishes installable Mac builds from source releases. ONScripter-Yuri lists any release tag that reads as a version and publishes its Mac executables as plain files or archives. A processor word in a file name lists the file for that processor, and a name without one serves both.

### Shared helpers and limits

Native engine managers share `github-runtime-catalog.js` for release and tag discovery and `runtime-catalog.js` for storing the cache on disk atomically. Each engine supplies only callbacks that map upstream metadata to versions, exact source commits and the assets that run on the host.

Engine catalogs choose Mac downloads through `release-files.js`. A download qualifies when its name has a Mac platform word or it is a disk image, and when its format is supported: ZIP, a plain, gzip, xz or bzip2 tar archive, or a disk image. The publisher's current file name is preferred. Files for other systems, debug symbols and sources are ignored, and a processor word in a name lists the download for that processor only.

After extraction, the expected executable, app bundle or framework is taken from its known path. When a release moves it, a search of the first three folder levels finds it, skipping archive metadata, hidden entries, links and the contents of app bundles. Minimum macOS versions come from the downloaded executables and app bundles. When that minimum stops an installation on an older Mac, the cached catalog records it. When the catalog identifies the file by SHA-256, a refresh keeps the measured minimum for that same digest. While that minimum is recorded, the version shows its macOS requirement, automatic selection skips it, and it is not downloaded again. A replaced file has no recorded minimum until its own download is checked.

An ordinary GitHub release query reads up to five pages of one hundred entries. A module can select up to twenty pages and two thousand cached entries through the shared helpers without changing the defaults of other managers. Impacto uses ten pages and one thousand entries so that older source releases stay listed, and the installable Mac packages for Impacto's Windows data profile come from MacLauncher Builds.

GitHub's numeric pagination links are followed only when they stay on the same API host and the configured repository path. Annotated tags are resolved to their commits.

### Commit snapshots

Projects without releases can use a shared commit provider, which lists commits up to a fixed limit. Each entry is identified by its exact commit and is not presented as a release. The default commit mapper uses `git-<40-character commit>` as the version and keeps the default branch's history order. Each version is labelled with the commit date and short commit, the first entry is marked HEAD, and the commit subject is kept as separate metadata.

Python tools installed from source can keep each provider's catalog in a separate `sourceId` cache. Refresh fetches metadata only, and Install downloads the selected commit's ZIP archive. The installation record stores the full commit, its `committedAt` time (separate from `installedAt`), the archive SHA-256 and byte count measured at download, and a hash for each file. The recorded archive hash is not a checksum published by the upstream project.

Each of these Python tools can declare `archiveLimits` for archive size, expanded size and entry count. Other tools use the defaults of 32 MiB, 64 MiB and 2,000 entries. Download, extraction and the installation record check use the same limits.

## Refresh results and installed versions

Available download lists come from explicit discovery or its cache. A successful refresh replaces that source's remote list. Version numbers with and without a `v` prefix share one row, and the upstream tag is kept as separate metadata. A Mac build of an exact commit and the published release of that version also share one row, unless the build and the release name different commits.

Changed or removed release metadata never points an installed binary at a different release: the installation record stores its original catalog entry, source revision and hashes. Older installed versions stay usable and removable, but they are not offered as downloads once the catalog no longer lists them.

A saved default stays selected after Refresh. Play uses it while it is installed or listed, or while no list has been loaded. When upstream has removed it and it is not installed, Play uses the newest listed or installed version instead.

## Integrity

When a publisher lists a digest or a size for a file, the download is checked against it. GitHub lists a SHA-256 digest for Actions artifacts and most release assets, although older release assets can lack one. A file without a publisher digest is downloaded over HTTPS from the location the publisher lists and passes the same structural checks as any other package: it must be a readable archive with the expected files and executables. Its SHA-256 is then recorded at installation. A recorded hash identifies the installed files; it is not a checksum from the publisher. Native architecture is checked after extraction.

Source-only releases and old assets without a compatible Mac package show why they cannot be installed. The selected version's reason takes precedence over general setup help, both in the installation help and in the disabled button's tooltip.
