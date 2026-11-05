# Project runtime catalogs

MacLauncher Builds publishes one catalog of runtime packages for each project,
and `maclauncher-builds.js` reads these catalogs from an explicitly named GitHub
repository and project. `fetchProjectCatalog(options, dependencies)` performs an
explicit refresh; importing the module, constructing a catalog URL and validating
records make no network requests. Download lists therefore show the last
refreshed catalog, and installed versions remain usable offline, even after they
are removed from the catalog.

A catalog of downloadable packages has a `packages` array. To be usable, a record
has to supply a safe version, an HTTPS archive URL and the archive's SHA-256.
Selection follows the known CPU and macOS requirements, whereas schema,
launcher-contract and provenance fields do not limit which MacLauncher versions
can install a record. Additional fields and files are also accepted. An unknown
architecture label, however, does not establish native compatibility;
installation inspects the actual executable instead. Invalid records are reported
one by one without hiding the catalog's other records.

The same rules apply to an installed record through
`validateProjectRecord(record, options)`, and `unavailablePins(projectId, rows)`
keeps unavailable catalog entries in the list together with their reasons.
Returned records are immutable copies in the publisher's order. Reading a catalog
does not choose a version or change runtime defaults. Code that reads the app's
package lock, the exact list of packages included in the app, instead passes
`managed: false` and keeps exact package validation.

`project-build-manager.js` connects catalog records to Runtimes, installation and
per-game selection, and `pinned-native-manager.js` also accepts a module's
`projectBuilds` project and repository. With `upstreamMacDownloads: true`, a
module can offer Builds packages alongside upstream downloads. The two sources
keep separate source links and download lists, but they share installed versions
and explicit choices.

A per-game choice takes precedence over the configured default. Automatic
selection uses the shared version resolver and prefers the native CPU, while
builds for the other CPU remain available in the **Build** menu. Refresh does not
change saved choices, and installing a version leaves the other installed
versions in place. Managers offer **Set default** unless they declare
`supportsDefault: false`.

Installation verifies the SHA-256 of the whole archive against the catalog,
extracts only safe paths and then resolves the manifest and executable that the
package declares. Paths in the manifest must stay inside the package, and
dependency links must stay inside the package or a declared dependency. Where a
package declares safe paths, they take precedence over the module's layout
defaults. A downloadable package is not tied to its exact metadata: additional
metadata, source labels, per-file inventories and recorded file hashes do not
have to match. Native signatures, actual CPU and OS support and operational
limits are still checked, and a feature that needs a particular runtime API
checks that API separately.

Downloaded dependencies are installed by the same installer, and their
own declarations supply their dependency and alias paths. Observations about
source and provenance are kept in the installation records, but the producer
and upstream trees do not have to be equal, and a missing source revision does
not prevent installation. Runtime assets and environment paths are resolved from
the installed package.

Packages included in the app work differently. They run directly from the app's
resources and cannot be removed separately, and their declarations in the app's
package lock keep the complete checks of the file list, per-file checksums,
permissions, source and metadata. Downloaded packages stay separate from the
identities of these included packages and from per-game data.
