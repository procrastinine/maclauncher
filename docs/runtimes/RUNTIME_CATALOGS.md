# Ordinary runtime release catalogs

NW.js, Java, Godot, and Ren'Py use one **Reload** action to load their complete bounded release lists. Their manager states set `supportsLatestOnly: false`; the UI does not offer a separate “All versions” action for these ordinary catalogs. GitHub Actions artifact catalogs such as LÖVE nightlies can still expose a reduced query because enumerating every artifact is slower.

Reading runtime state, opening the runtime panel, switching tabs, or resolving an installed runtime stays offline. Available-release lists begin empty until an explicit query or a saved catalog is available. Included, installed and explicitly resolved game versions remain selectable independently. Catalog lookup follows Reload/version actions or an explicit Play or tool action that needs exact release metadata; payload downloads require consent. Refresh does not change a selected default or a per-game version override.

## Sources and bounds

| Manager | Source | Ordinary refresh | Bound |
| --- | --- | --- | --- |
| NW.js | [Official version index](https://nwjs.io/versions.json), with official download-index fallbacks | Exact stable `major.minor.patch` releases, newest first | 500 versions |
| Java | [Adoptium API](https://api.adoptium.net/swagger-ui/) | macOS HotSpot JDK GA releases for each supported LTS line, merging Apple Silicon and Intel assets by exact version | 5 pages × 20 releases per architecture; the low-level pager permits at most 10 pages |
| Godot | [Official archive](https://godotengine.org/download/archive/) | Exact archive releases, including stable, RC, beta, alpha, and development builds, newest first | 500 versions |
| Ren'Py | [Official download index](https://www.renpy.org/dl/), checked against the [current release](https://www.renpy.org/latest.html) or [Python 2 release](https://www.renpy.org/latest-7.html) | All numeric releases in the selected Python generation up to its latest stable version | 500 versions per group |

Adoptium documents a maximum `page_size` of **20** in its [OpenAPI specification](https://api.adoptium.net/openapi). Larger values can return a successful but shortened response. The Java pager therefore requests 20, advances through full pages, and retains earlier results when the final page returns an empty list, HTTP 204, or HTTP 404. It rejects malformed non-array responses. Java 8 lacks an Apple Silicon asset in the checked catalog and can use an Intel runtime through the existing Rosetta path.

NW.js uses the index's `files` and `flavors` to report native, Rosetta, or unavailable SDK builds per version. Known versions without an SDK flavor or a usable Mac architecture remain visible in history but are excluded from `installableVersions`. Entries without architecture metadata show availability as unknown.

Godot's current installer selects macOS **.NET** bundles. Its archive also contains older versions without a .NET package. Ren'Py's Python 2 group preserves historical releases, including early releases without the SDK DMG expected by the current installer. Historical entries without a matching Mac package remain visible with installation disabled. Installation and launch check the selected package’s CPU and macOS requirements.

## Caches and version selection

Successful catalog results have a six-hour process-local cache. `force: true` bypasses that cache. Failed requests retain the last valid rows, their identities and their last successful query time; they can be retried immediately.

Backend callers may explicitly request `latestOnly: true`; omitting it requests the full list. Ordinary runtime panels always request the full list. The cache tracks the requested mode, so a reduced result cannot satisfy an ordinary full refresh. A full refresh arriving during a reduced request waits for that request and then fetches history. Concurrent requests for the same mode share their pending request.

The latest available value comes from the remote catalog, while the selected default and latest installed values remain separate. Java preserves architecture choices and reports availability per exact version. Ren'Py keeps Python 2 and Python 3 catalogs separate and includes the official latest stable version even if the directory index has not caught up.

Java displays Adoptium's exact `openjdk_version`, including a fourth patch component. For example, upstream `17.0.20.1+1` must not become `17.0.20+101` merely because Adoptium also publishes that encoded SemVer value. Catalog lookup retains aliases supplied by the same release metadata, so an earlier stored SemVer key can still select its corresponding package; new installs use the canonical OpenJDK version. Existing installed directories and explicit selections keep their original keys, and a missing exact installed version remains missing rather than selecting another release.

## Shared GitHub native catalogs and other ordinary releases

Ruffle, LÖVE stable releases, ONScripter-Yuri Web, Ikemen GO, HashLink and GemRB use
bounded shared GitHub release pagination. Ruffle ordinary Reload defaults to
all releases; only the slower LÖVE GitHub Actions artifact section exposes a
latest-only option. LÖVE nightly labels include the upstream version from
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
offline, and only its pinned Windows Mac version is installable for that profile.
GitHub's canonical numeric repository pagination links are accepted only on the
same API host and pinned repository path. Annotated tags are peeled to commits.
No-release projects can use the shared bounded immutable commit provider;
source snapshots carry exact commit identities rather than fabricated releases.

Pinned acquisition and build identities remain available internally without
appearing as previously fetched upstream releases. Fixed offline catalogs keep
their exact versions. Successful refresh replaces the remote list. Numeric `v` prefixes canonicalize
without duplicate rows, while upstream tags remain separate metadata. A pinned
Mac build and its published release share one row; differing build/release
commits remain explicit. Removed or replaced release metadata never rebinds an
installed binary: its record stores the original catalog entry, source revision
and hashes. Historical installed entries remain usable or removable but do not
remain stale available download options.

Publisher archive SHA-256 is verified when available. Historical GitHub assets
without a published digest must explicitly opt into recorded-local integrity;
the archive and executable hashes are recorded locally. Native architecture validation runs after extraction.
Source-only releases and old assets without a compatible Mac package show the reason installation is unavailable.
The selected version's reason takes precedence over general setup help, in the existing installation help and disabled button tooltip.

HashLink and GemRB distinguish installable Mac builds from source releases.
