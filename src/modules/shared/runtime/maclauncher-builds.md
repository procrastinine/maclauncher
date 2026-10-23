# Project runtime catalogs

`maclauncher-builds.js` reads versioned runtime packages from an explicitly named
GitHub repository and project. `fetchProjectCatalog(options, dependencies)` is an
explicit refresh operation. Loading the module, constructing its catalog URL and
calling `validateProjectCatalog` make no network requests. Existing runtime
managers select when to offer refresh and installation actions. Download lists
start empty. Explicit Refresh writes a local catalog; subsequent offline views
use that cache. Module source pins and installed records do not seed downloads.

Both operations require `projectId` and an `owner/repository` value. Catalogs use
schema version 2, the matching `projectId`, a `manual` update policy and an ordered
`packages` array. A package's project ID, version and architecture determine its
release tag and filename. Download URLs must identify that exact repository,
encoded tag and filename. Package records also retain manifest/source checksums,
the archive checksum and size, launcher architectures and the minimum macOS
version. Archives are limited to 4 GiB.

The complete catalog is validated before optional filtering by launcher
architecture. Duplicate version/architecture pairs, mixed projects and download
identities that do not match the selected project are rejected. Returned records
are copied and immutable. Publisher ordering is retained; the helper does not
choose a latest version, install packages or change runtime defaults.

`project-build-manager.js` connects these catalogs to the ordinary Runtimes
Refresh, Install and version-selection actions. It reuses pinned native
installation and download coordination. Status and Play read only the local
catalog. Unpinned selections prefer the usable included package; otherwise they
use the catalog's first compatible package. Refresh discovers available versions
without replacing a usable included default. Explicit per-game and default
versions remain selected. Installing a version sets the default only when none
is configured; **Set default** changes an existing default. Included packages
run directly from app resources and cannot be removed separately. Each downloaded
version retains its catalog identity and a separate sealed payload; installation
verifies the archive, complete manifest inventory, source checksum, file modes
and native architectures before publishing the version directory.
The optional `retainedIncluded(options)` callback supplies trusted, physically retained included packages for explicit selections while `included(options)` remains the automatic default.
An optional `runtimeId` maps per-game inspector choices to a project whose
manager ID differs from its runtime ID. The module retains the selected runtime
lease through preparation and execution.

Modules can select `filesPrefix` and `sourceRelative` from the validated package
using callbacks, alongside the existing executable selector. Returning `null`
for `sourceRelative` keeps separately distributed corresponding source out of
the installed runtime; the module checks its pinned source checksum. Existing
packages keep their original layout and source handling.

`pinned-native-manager.js` also accepts module-owned `projectBuilds` metadata with
an explicit project ID and repository. Refresh reads the project's hosted catalog.
Modules with compatible upstream macOS downloads also declare
`upstreamMacDownloads: true` and query that publisher independently. Modules whose
upstream releases do not provide compatible Mac packages link to upstream code
without listing its other-platform releases. Hosted records must match a supported module pin;
the original source revision, adaptation hashes and corresponding-source
checksum remain authoritative. The hosted archive replaces the download for
that exact version, while included packages and explicit choices retain their
existing behavior. A hosted installation verifies its sealed manifest, complete
file inventory and signatures, and bypasses upstream compilation and installer
preparation. Runtime resources remain beneath the version's `project-payload`
directory and undergo full checksum verification before execution. Installed
records and cached catalogs remain available offline.

`catalog.sources` provides a separate download list, source URL, version labels,
compatibility requirements and installation capability for each publisher.
`catalog.sourceLinks` provides secondary code or publisher links. The installed
list and exact per-game runtime identities remain shared across sources.
Successful Refresh replaces available releases; removed releases remain usable
through their verified installed records. Damaged downloads can be reinstalled
from a complete verified staging directory with rollback of a failed replacement.
