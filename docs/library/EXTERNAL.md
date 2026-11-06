# External game libraries

**External**, next to Settings, opens a separate native window for installed games and store downloads. Reopening it focuses the existing window, and the library stays usable while imports and downloads run.

## Installed games

**Installed** lists the Steam, Epic Games, GOG and itch.io games installed in common macOS and CrossOver locations. It reads local store manifests, registered Steam libraries, Heroic and Legendary installation records, GOG game metadata and itch.io install receipts. Versions that MacLauncher downloaded separately appear in **Downloaded** instead. Scanning and the reload button stay offline, and the artwork comes from local files.

Steam app manifests do not record what kind of app they install, so the type of each installed Steam app comes from the local app cache of the Steam client that installed it, or from another Steam client's cache when that one lacks it. Games, applications, demos, mods, soundtracks and betas are listed. Tools, configurations and Steam's own shared components, such as the Steamworks Common Redistributables, are not. An app that no local cache describes remains listed. The account library in the Steam tab applies the same rule.

Each row shows the game, its store, its location, its platform (Mac, Windows or Linux), local version information and its import status.

- The location names where the game was found: **CrossOver bottle:** and the bottle name, **MacLauncher downloads**, the store or tool library that recorded it, or **Local library**. The tooltip shows the full path.
- The Version column shows the version the publisher recorded. A store build number is never shown as an installed game's version, and the cell's tooltip lists the version, branch and build. Missing version information is shown as a dash. In **Downloaded**, a copy without a recorded version shows **Build** and its build number.

Search, sorting and filters for store, platform and import status narrow the table. Platform filters list only the platforms present, each with its number of games. The footer counts the listed games as **N games**, or as **N of M games** while filters hide some (in **Downloaded**, it counts copies), and shows the selection count while games are selected. Checkboxes select games, Shift-click selects a range, and the header checkbox selects the visible games without clearing selections hidden by the filter.

**Import** queues the selected games in the background. Existing installations stay in place, the library updates as each import completes, and External keeps the focus. Imported tags follow the registered game paths, including app bundles or executables selected inside a store's game folder.

## Downloaded copies

**Downloaded** lists the separately stored versions that MacLauncher recorded, including those in custom locations. This view works offline, remains available after the app restarts, and has its own selection and import controls. These copies are separate from store-managed installations and are not updated automatically. Each download records exactly which content it holds, and downloading another edition creates a new folder.

**Open downloads in Finder** opens the default collection, and each store's destination controls offer **Open default in Finder** for that store's folder.

## Download tabs

Steam, Epic, GOG, itch.io and Android each have a tab. Opening a tab reads cached data, and only connecting, reloading, refreshing versions and downloading use the network. Account and version metadata are cached. Each selected game has explicit controls for the version or build, the platform and the language, where the store supplies them. Library filters include platform tags and Steam ownership, and sorting changes the visible order without clearing the selection. Question-mark buttons explain account modes, version limits and download locations, and circular-arrow buttons reload the list or version catalog next to them.

Downloaded content stays subject to the account's and publisher's access rules. Downloading a game for a platform does not mean that MacLauncher has a compatible runtime for it.

### Versions

| Store | Version selection |
| --- | --- |
| Steam | Publisher branches, build IDs, individual depot manifests, previously observed manifests and exact historical manifest IDs |
| Epic | Published platform builds and an optional exact historical manifest URL |
| GOG | Available offline installer versions and Galaxy content builds, including previous builds that GOG returns |
| itch.io | Public upload editions from game links; with account access, individual builds as well, including available earlier builds |
| Google Play | The current version for selected Android device profiles, and exact known version codes, with the required APK splits |
| F-Droid and IzzyOnDroid | Published APK versions with exact hashes, CPU architectures and Android SDK requirements |

Steam and Epic do not provide a complete historical catalog through these interfaces. Known historical manifests can be entered explicitly, and removed or restricted content remains subject to store authorization. An explicit version selection is kept for the download and is never silently replaced with the latest release.

**Fetch previous versions** requests SteamDB's manifest history for the selected depots of the chosen game only. The results are cached by game and depot, with full manifest IDs and available dates. Fetching history adds choices without changing the selected content. SteamDB may require browser access; when a direct request is not possible, **Open SteamDB** opens the matching manifest page. A known manifest ID can still be entered directly.

### Platforms and architectures

Steam's platform choices include published Android depots alongside the Mac, Windows and Linux editions. Android depots stay separate from the PC editions, and shared depots without a platform tag come with the selected platform. When automatic import is on, downloaded APKs go through the ordinary Android package import.

Steam's architecture choices come from depot restrictions and published executable metadata. For macOS, they distinguish 32-bit, 64-bit and Apple Silicon when the publisher declares them. An unspecified architecture stays unspecified, and shared game data is not labeled as a separate executable build. A depot marked 64-bit can accompany an Apple Silicon executable. Android ARM64 is shown only when the publisher's CPU metadata specifies it; an Android or 64-bit platform flag alone does not establish ARM64. For local Mac installations, the Mach-O slices of the executable identify Intel, Apple Silicon and universal binaries when they are available.

### Duplicates and destinations

Before transferring content to the default collection, MacLauncher compares the saved app, platform and exact version. When it finds a duplicate, a warning offers **Use existing copy**, **Download again** and **Cancel**. Steam compares the manifest IDs of the selected depots; the other stores compare their published build, upload or installer IDs. Custom destinations are separate collections. A hosted file without a stable revision identifier is never assumed to be an exact duplicate.

**Import into MacLauncher when the download finishes** starts checked; clearing it downloads without adding a game to the library. MacLauncher's own download folder is the default destination, and **Choose folder…** selects a custom parent folder. Each download creates its own version folder and leaves existing installations untouched. Progress, cancellation, paths and import results stay visible in External, and completed content can be imported later. Archives and installers go through the ordinary import and preparation, and the downloaded files stay available when no supported game can be added.

## Steam accounts

**Reuse Steam** uses the account signed in to the running Mac Steam app, through its console. Owned games and family-sharing licenses come from that session, and its credentials are not copied. Steam's local metadata supplies names, platforms and build information, and Steam may bring its window forward while it processes session commands. Steam downloads the requested depots into a staging area separate from installed games, and MacLauncher then copies them into the selected destination. After the copy and download receipts are published, staging depot folders created by that download are removed, along with their app folder when empty. Pre-existing depot folders and staging from failed or interrupted copies are preserved. Cancelling stops that copy and the import, although Steam may continue its own transfer. Game metadata comes from Steam's local app cache. Missing information and explicit metadata refreshes use an anonymous Steam connection, without opening or foregrounding the desktop Steam app.

**Sign in manually** creates a separate Steam session inside External. Steam Guard codes and mobile or email approvals are handled in the window, and QR sign-in shows a locally generated code for the Steam challenge. Several manual accounts and the Mac Steam account appear in the account selector. Switching accounts changes the library being browsed, while downloads already started keep their original account. **Add account** opens another sign-in, and **Remove account** forgets that manual sign-in.

Remembered manual sign-ins store encrypted refresh tokens protected by the macOS Keychain. Opening External lists the account names without accessing the Keychain; connecting or saving a manual sign-in accesses its encrypted credentials. Passwords are used to sign in and are never saved. Steam platform selection does not depend on the host Mac and includes published 32-bit Mac content. Private branches require access from the publisher and may require a manual sign-in.

## Epic, GOG and itch.io accounts

Epic and GOG can reuse supported local sign-ins from Heroic, Legendary or the store's own tools without changing their configuration. Manual sign-in opens the store's authorization page in the browser and accepts the code it returns. Epic downloads use a Legendary helper, and GOG Galaxy builds use a native GOGdl helper; both are downloaded automatically when a download needs them. These helpers are internal and have no entry in **Runtimes**. GOG also offers offline installers with their version, platform and language metadata. Each installer file is checked against the size and MD5 in the checksum record GOG publishes for it, and keeps the file name that record gives.

itch.io starts in **Public games** mode. Pasting the URL of a public itch.io game adds its downloadable uploads without an API key. Free and pay-what-you-want files remain subject to the publisher's access and pricing settings. Public pages offer upload editions, and earlier build archives need the access itch.io grants. A selected upload is never silently replaced with another edition. Added game links are cached locally, and the circular arrow reloads those pages only on request.

**Account library** uses an optional API key for owned purchases, claims, gifts and bundles. **Save API key** starts unchecked, and a saved key is encrypted until **Forget saved key** removes it. **Disconnect** clears the active session. API keys are sent in Authorization headers, never in request URLs. Switching to public mode does not delete a saved key.

## Android

The Android tab searches Google Play, F-Droid and IzzyOnDroid and shows each source's results as they arrive. Google Play uses browser sign-in by default, shared with **Settings → Android**, and existing accounts of supported providers can be selected without opening an Android sign-in. Repository search works without an account. [Android app downloads](GOOGLE_PLAY.md) describes purchase history, app search, device profiles and exact APK editions.

## Storage

`userData` is normally `~/Library/Application Support/maclauncher/`.

| Location | Contents |
| --- | --- |
| `external/downloads/steam/` | Steam downloads in the default folder, separated by app, platform and version |
| `steam/accounts/` | Metadata caches of manual accounts, one per account |
| `steam/session.enc` | Optional encrypted manual Steam sign-ins |
| `steam/installations.json` | Completed Steam downloads, including custom locations |
| `external/downloads/<store>/` | Downloaded versions for Steam, Epic, GOG, itch.io, Google Play, F-Droid and IzzyOnDroid, each in its own folder |
| `external/installations.json` | Completed external downloads, including custom locations |
| `external/tools/` | Shared, versioned download helpers |
| `external/<store>/session.enc` | Optional encrypted store session or API key |
| `external/itch/public/library.json` | Cached public itch.io game links and metadata |

Each completed version holds download metadata that records its store, app, platform and exact version. Importing an installation registers its path without copying it into the per-game records folder. Settings and generated runtime data follow the usual [data layout](../development/DATA_MODEL.md).
