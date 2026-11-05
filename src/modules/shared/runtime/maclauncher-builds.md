# Project runtime catalogs

`maclauncher-builds.js` reads runtime catalogs from an explicitly named GitHub
repository and project. `fetchProjectCatalog(options, dependencies)` performs an
explicit refresh. Importing the module, constructing a catalog URL and validating
records make no network requests. Download lists use the last refreshed catalog;
installed versions remain usable offline even after removal from the catalog.

Managed catalogs have a `packages` array. Each usable record supplies a safe
version, an HTTPS archive URL and its SHA-256. Known CPU and macOS requirements
control selection. Schema, launcher-contract and provenance fields do not impose
an app-version ceiling. Additional fields and files are accepted. Unknown
architecture labels do not establish native compatibility: installation inspects
the actual executable. Invalid records are reported individually without hiding
the catalog's other records.

`validateProjectRecord(record, options)` applies the same rules to an installed
record. `unavailablePins(projectId, rows)` retains unavailable catalog entries with
their reasons. Returned records are copied and immutable; publisher ordering is
preserved. Catalog reading does not choose a version or change runtime defaults.
App-lock readers pass `managed: false` and retain exact package validation.

`project-build-manager.js` connects catalog records to Runtimes, installation and
per-game selection. `pinned-native-manager.js` also accepts a module's
`projectBuilds` project and repository. A module can combine Builds packages with
upstream downloads through `upstreamMacDownloads: true`. Source links and download
lists remain separate, while installed versions and explicit choices are shared.

A per-game choice takes precedence over the configured default. Automatic
selection uses the shared version resolver and native CPU preference. The other
CPU's builds remain available in the existing dropdown. Refresh does not change
saved choices, and installing a version leaves other installed versions in place.
Managers offer **Set default** unless they declare `supportsDefault: false`.

Installation verifies the catalog's whole-archive SHA-256, extracts safe paths and
resolves the package's declared manifest and executable. Manifest paths must stay
inside the payload; dependency links must stay inside the payload or a declared
dependency. Declared safe paths take precedence over module layout defaults.
Additional metadata, source labels, per-file inventories and recorded file hashes
do not pin a downloadable package. Native signatures, actual CPU and OS support,
and operational bounds remain checked. A feature that needs a particular runtime
API checks that API independently.

Downloaded dependencies use the same managed installer. Their own declarations
supply dependency and alias paths. Source and provenance observations are retained
in receipts without requiring equality between the producer and upstream trees.
A missing source revision does not prevent installation. Runtime assets and
environment paths resolve from the installed package.

Included packages run directly from app resources and cannot be removed
separately. Their app-lock declarations retain complete inventory, per-file
digests, permissions, source and metadata checks. Downloaded packages remain
separate from these included identities and from per-game data.
