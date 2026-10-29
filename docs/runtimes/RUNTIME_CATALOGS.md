# Ordinary runtime release catalogs

NW.js, Java, Godot, and Ren'Py use one **Reload** action to load their complete bounded release lists. Their manager states set `supportsLatestOnly: false`; the UI does not offer a separate “All versions” action for these ordinary catalogs. GitHub Actions artifact catalogs whose history spans many pages (MKXP-Z upstream builds, LÖVE nightlies and Butterscotch) expose two controls: the refresh control runs a bounded scan that lists the newest successful build, and **All versions** requests the broader history.

Reading runtime state, opening the runtime panel, switching tabs, or resolving an installed runtime stays offline. Available-release lists begin empty until an explicit query or a saved catalog is available. Each source shows a short description of what it publishes; a source without listed versions offers **Load versions**, which remains available after a failed request, and a successful query that finds nothing reports that the source has no downloadable versions. Installed and explicitly resolved game versions remain selectable independently. Catalog lookup follows Refresh or an explicit Play/tool action that needs exact release metadata; payload downloads require consent. Refresh preserves selected defaults and per-game versions.

## Sources and bounds

| Manager | Source | Ordinary refresh | Bound |
| --- | --- | --- | --- |
| NW.js | [Official version index](https://nwjs.io/versions.json), with official download-index fallbacks | Exact stable `major.minor.patch` releases, newest first | 500 versions |
| Java | [Adoptium API](https://api.adoptium.net/swagger-ui/) | macOS HotSpot JDK GA releases for each supported LTS line, merging Apple Silicon and Intel assets by exact version | 5 pages × 20 releases per architecture; the low-level pager permits at most 10 pages |
| Godot | [Official archive](https://godotengine.org/download/archive/) | Exact archive releases, including stable, RC, beta, alpha, and development builds, newest first | 500 versions |
| Ren'Py | [Official download index](https://www.renpy.org/dl/), checked against the [current release](https://www.renpy.org/latest.html) or [Python 2 release](https://www.renpy.org/latest-7.html) | All numeric releases in the selected Python generation up to its latest stable version | 500 versions per group |

Adoptium documents a maximum `page_size` of **20** in its [OpenAPI specification](https://api.adoptium.net/openapi). Larger values can return a successful but shortened response. The Java pager therefore requests 20, advances through full pages, and retains earlier results when the final page returns an empty list, HTTP 204, or HTTP 404. It rejects malformed non-array responses. Java 8 lacks an Apple Silicon asset in the checked catalog and can use an Intel runtime through the existing Rosetta path.

NW.js uses the index's `files` and `flavors` to report native, Rosetta, or unavailable SDK builds per version. Known versions without an SDK flavor or a usable Mac architecture remain visible in history but are excluded from `installableVersions`. Entries without architecture metadata show availability as unknown.

Godot installs macOS **Standard** or **.NET** bundles according to the selected variant and the game's scripting requirements. Its archive also contains older versions without a .NET package. Ren'Py's Python 2 group preserves historical releases, including early releases without the SDK DMG expected by the current installer. Historical entries without a matching Mac package remain visible with installation disabled. Installation and launch check the selected package’s CPU and macOS requirements.

## Caches and version selection

Successful catalog results have a six-hour process-local cache. `force: true` bypasses that cache. Failed requests retain the last valid rows, their identities and their last successful query time; they can be retried immediately.

For ordinary release catalogs, backend callers may request `latestOnly: true`; omitting it requests the full list, and runtime panels always request the full list. GitHub Actions artifact catalogs treat an omitted `latestOnly` as the bounded newest-build scan; `latestOnly: false` requests the broader history, which the **All versions** button sends. The cache tracks the requested mode, so a reduced result cannot satisfy an ordinary full refresh. A full refresh arriving during a reduced request waits for that request and then fetches history. Concurrent requests for the same mode share their pending request.

The latest available value comes from the remote catalog, while the selected default and latest installed values remain separate. Java preserves architecture choices and reports availability per exact version. Ren'Py keeps Python 2 and Python 3 catalogs separate and includes the official latest stable version even if the directory index has not caught up.

Java displays Adoptium's exact `openjdk_version`, including a fourth patch component. For example, upstream `17.0.20.1+1` must not become `17.0.20+101` merely because Adoptium also publishes that encoded SemVer value. Catalog lookup retains aliases supplied by the same release metadata, so an earlier stored SemVer key can still select its corresponding package; new installs use the canonical OpenJDK version. Existing installed directories and explicit selections keep their original keys, and a missing exact installed version remains missing rather than selecting another release.

## Shared GitHub native catalogs and other ordinary releases

Sikarugir explicitly refreshes the publisher's Engines and Template releases,
with at most five pages per repository. Only compatible versioned engine assets
and matching support archives with publisher SHA-256 metadata are installable.
Its version identity combines the Wine version, engine checksum, Template version
and Template checksum; the rolling `v1.0` release tag does not identify a Wine
version. Installed snapshots remain selectable after refresh. Opening the Wine
panel stays offline; Play can request the missing exact download after consent.

Ruffle, LÖVE stable releases, ONScripter-Yuri Web, Ikemen GO, HashLink and GemRB use
bounded shared GitHub release pagination. Ruffle ordinary Reload defaults to
all releases; the LÖVE GitHub Actions nightly section refreshes its newest build
and offers **All versions** for the broader history. LÖVE nightly labels include the upstream version from
`src/common/version.h` at the exact workflow commit, alongside that commit and
date. A branch such as `main` is never presented as a runtime version. Full
nightly workflow queries are bounded to ten pages of fifty runs.

Pinned managers share `github-runtime-catalog.js` for release/tag discovery
and `runtime-catalog.js` for atomic offline cache persistence. Engine callbacks
only map upstream metadata to versions, source pins and supported host assets.
Normal GitHub release queries default to five pages of one hundred entries.
Modules can explicitly select up to twenty pages and two thousand cached entries
through the shared helpers without changing other managers' defaults. Impacto
uses ten pages and one thousand entries to retain older source releases. Reading that persisted history remains
offline; installable Mac packages for its Windows profile come from MacLauncher Builds.
GitHub's canonical numeric repository pagination links are accepted only on the
same API host and pinned repository path. Annotated tags are peeled to commits.
No-release projects can use the shared bounded immutable commit provider;
source snapshots carry exact commit identities rather than fabricated releases.
The default commit mapper uses `git-<40-character commit>` identities, preserves
default-branch history order and labels versions with the commit date and short
commit, with HEAD on its first entry. The commit subject remains separate metadata.
Managed Python source tools can keep provider catalogs in
separate `sourceId` caches. Refresh fetches metadata; Install downloads only the
selected immutable commit ZIP after consent. The installed record contains the
full commit and its `committedAt` timestamp separately from `installedAt`, the
observed archive SHA-256 and byte count, and per-file hashes, without claiming
an upstream-published archive checksum.
Each managed Python tool can declare `archiveLimits` for archive bytes, expanded
bytes and entry count. Other tools retain the defaults of 32 MiB, 64 MiB and
2,000 entries. Download, extraction and installed-record checks use the same
declared limits.

Available download lists come from explicit discovery or its cache. Successful refresh
replaces that source's remote list. Numeric `v` prefixes canonicalize
without duplicate rows, while upstream tags remain separate metadata. A pinned
Mac build and its published release share one row; differing build/release
commits remain explicit. Removed or replaced release metadata never rebinds an
installed binary: its record stores the original catalog entry, source revision
and hashes. Historical installed entries remain usable or removable but do not
remain stale available download options.

Publisher archive SHA-256 is verified when available. Historical GitHub assets
without a published digest must explicitly opt into recorded-local integrity;
the archive and executable hashes are recorded locally. Official publisher
archives without published checksums additionally require module-validated,
version-specific HTTPS artifact identities and exact download sizes. These local
hashes identify installed bytes without claiming publisher checksum verification.
Native architecture validation runs after extraction.
Source-only releases and old assets without a compatible Mac package show the reason installation is unavailable.
The selected version's reason takes precedence over general setup help, in the existing installation help and disabled button tooltip.

HashLink and GemRB distinguish installable Mac builds from source releases.
