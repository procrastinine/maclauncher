# Project runtime catalogs

`maclauncher-builds.js` reads versioned runtime packages from an explicitly named
GitHub repository and project. `fetchProjectCatalog(options, dependencies)` is an
explicit refresh operation. Loading the module, constructing its catalog URL and
calling `validateProjectCatalog` make no network requests. Existing runtime
managers select when to offer refresh and installation actions. Download lists
start empty. Explicit Refresh writes a local catalog; subsequent offline views
use that cache. Module source pins and installed records do not seed downloads.

Both operations require `projectId` and an `owner/repository` value. Catalogs use
schema version 2 or later, the matching `projectId`, a `manual` update policy and
an ordered `packages` array. A package's project ID, version and architecture determine its
release tag and filename. Download URLs must identify that exact repository,
encoded tag and filename. Package records also retain manifest/source checksums,
the archive checksum and size, launcher architectures and the minimum macOS
version. Archives are limited to 4 GiB.

Each record is validated separately before optional filtering by launcher
architecture. A record whose launcher architectures name only another known Mac
CPU is not offered. An invalid record does not hide the catalog's other records. A
record with a safe version that cannot be used is returned in `unavailable` with
its reason, unless a usable record has the same version; this includes duplicate
version/architecture pairs, records for other projects and download identities
that do not match the selected project. A record without a safe version is
omitted. Only a catalog for another project, another update policy or an earlier
schema is rejected as a whole. `validateProjectRecord(record, options)` applies
the same checks to one recorded entry and throws its reason. Returned records
are copied and immutable, and unknown fields are ignored. Publisher ordering is
retained; the helper does not choose a latest version, install packages or
change runtime defaults.

A record with a schema version above 2, a `launcherContract` above the
module's `launcherContract` option, or an architecture name this launcher does
not know is listed with "Requires a newer MacLauncher." `launcherContract` is a positive integer and defaults to 1 for both
records and modules. A project raises it when a package needs launcher behavior
that earlier launchers lack, such as a changed controller protocol or package
layout. Additive fields need no new contract. Both manager types pass the
module's value, and `unavailablePins(projectId, rows)` turns unavailable records
into download-list rows that show the reason and cannot be installed.

A record may describe itself with `source` (`repository`, a 40-character
`revision` and an optional `path`) and `capabilities`, an object of facts that
modules read to match a game with a runtime, such as a native API name, feature
list or supported data versions. Capability names start with a letter and
contain only letters, digits and underscores; a record has at most 64 of them,
nested at most three levels, in at most 8 KiB of JSON. Each module checks the
values it reads, so an unexpected value fails that module's match rather than
the catalog.

`project-build-manager.js` connects these catalogs to the ordinary Runtimes
Refresh, Install and version-selection actions. A record with another
`manifestRelative` is listed as requiring a newer MacLauncher. It reuses pinned native
installation and download coordination. Status and Play read only the local
catalog. A per-game version takes precedence over the default version. Without
either, selection uses the newest usable installed or included package, ordered
by `version-order.js`. Packages that differ only by a build hash follow the
cached catalog order (the earlier-listed wins), and require an explicit choice
when one is not listed. No catalog entry is chosen automatically. Refresh lists available versions without changing selections,
and installation does not set a default. Managers backed by a Builds project
offer **Set default** unless they declare `supportsDefault: false`. Included
packages run directly from app resources and cannot be removed separately. Each
downloaded version retains its catalog identity and a separate sealed payload;
installation verifies the archive, complete manifest inventory, source checksum,
file modes and native architectures before publishing the version directory.
The optional `retainedIncluded(options)` callback supplies trusted, physically retained included packages alongside the current `included(options)` package.

A project can publish several versions, including several revisions of one
upstream version such as `0.41.0-MCLv1` and `0.41.0-MCLv2`. Each version is a
separate catalog record, download, installation directory and runtime lease.
Installing one version leaves the others installed, and a version withdrawn from
the catalog remains usable through its verified installation.
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
without listing its other-platform releases. Every valid hosted record is
listed and installable. Its `source.revision` identifies its source; a record
without `source` uses the revision of the module's build recipe for the same
version, and an installed record keeps the revision recorded at installation. A
record with no source revision is listed with that reason and cannot be
installed. The record's `capabilities` become fields of its catalog entry, after
any same-version recipe facts and before the entry's identity fields, so modules
read the same names from hosted and upstream entries. The sealed manifest must
name the same source revision, and the module's manifest validation receives
that catalog entry at installation. The hosted archive replaces the download for
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
