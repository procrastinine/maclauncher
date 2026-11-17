# External game libraries

MacLauncher can import games that Steam, Epic Games, GOG and itch.io have already installed on the Mac, and it can download games from those stores and from Android app sources. Both are done in a separate native window, opened with **External** next to Settings. Reopening it focuses the existing window, and the library stays usable while imports and downloads run.

## Installed games

**Installed** lists the Steam, Epic Games, GOG and itch.io games installed in common macOS and CrossOver locations. To find them, it reads local store manifests, registered Steam libraries, Heroic and Legendary installation records, GOG game metadata and itch.io install receipts. Versions that MacLauncher downloaded separately appear in **Downloaded** instead. Scanning and the reload button stay offline. Artwork from local files is shown as soon as each row appears, while artwork from a connected account or a store's servers loads as its row scrolls near the view.

Steam app manifests do not record what kind of app they install. The type of each installed Steam app therefore comes from the local app cache of the Steam client that installed it, or from another Steam client's cache when that one lacks it. Games, applications, demos, mods, soundtracks and betas are listed, while tools, configurations and Steam's own shared components, such as the Steamworks Common Redistributables, are left out. An app that no local cache describes stays listed. The account library in the Steam tab follows the same rule.

Each row shows the game, its store, its location, its platform (Mac, Windows or Linux), local version information and its import status.

- The location names where the game was found: **CrossOver bottle:** and the bottle name, **MacLauncher downloads**, the store or tool library that recorded it, or **Local library**. The tooltip shows the full path.
- The Version column shows the version the publisher recorded, and the cell's tooltip lists the version, branch and build. A store build number is never shown as an installed game's version, and missing version information appears as a dash. In **Downloaded**, a copy without a recorded version shows **Build** and its build number.

The table can be searched, sorted and filtered by store, platform and import status. Platform filters list only the platforms present, each with its number of games. In the footer, the listed games are counted as **N games**, or as **N of M games** while filters hide some (in **Downloaded**, copies are counted), and the selection count appears while games are selected. Games are selected with their checkboxes, Shift-click selects a range, and the header checkbox selects the visible games without clearing selections that the filter hides.

**Import** queues the selected games in the background. Existing installations stay where they are, the library updates as each import completes, and External keeps the focus. Each row's import status follows the registered game paths, which includes app bundles or executables selected inside a store's game folder.

## Downloaded copies

**Downloaded** lists the separately stored versions that MacLauncher has recorded, including those in custom locations. The view works offline, remains available after the app restarts, and has its own selection and import controls. Because these copies are separate from the installations a store keeps up to date, they are never updated automatically. Each download records exactly which content it holds, and downloading another edition creates a new folder.

**Open downloads in Finder**, a folder button in the **Downloaded** toolbar, opens the default collection. Each store's destination controls have their own folder button, **Open default in Finder**, for that store's folder.

## Download tabs

Steam, Epic, GOG, itch.io and Android each have a tab. Account and version metadata are cached, so opening a tab reads cached data, and only connecting, reloading, refreshing versions and downloading use the network. Where the store supplies them, each selected game has explicit controls for the version or build, the platform and the language. Library filters include platform tags and Steam ownership, and sorting changes the visible order without clearing the selection. Question-mark buttons explain account modes, version limits and download locations, and circular-arrow buttons reload the list or version catalog next to them.

Downloaded content stays subject to the account's and publisher's access rules. A game downloaded for a platform may still have no compatible runtime in MacLauncher.

### Versions

| Store | Version selection |
| --- | --- |
| Steam | Publisher branches, build IDs, individual depot manifests, previously observed manifests and exact historical manifest IDs |
| Epic | Published platform builds and an optional exact historical manifest URL |
| GOG | Available offline installer versions and Galaxy content builds, including previous builds that GOG returns |
| itch.io | Public upload editions from game links; with account access, individual builds as well, including available earlier builds |
| Google Play | The current version for selected Android device profiles, and exact known version codes, with the required APK splits |
| F-Droid and IzzyOnDroid | Published APK versions with exact hashes, CPU architectures and Android SDK requirements |

Steam and Epic do not provide a complete historical catalog through these interfaces, so known historical manifests can be entered explicitly. Removed or restricted content remains subject to store authorization. An explicit version selection is kept for the download and is never silently replaced with the latest release.

**Fetch previous versions** requests SteamDB's manifest history, only for the selected depots of the chosen game. The results are cached by game and depot, with full manifest IDs and available dates, and they add choices without changing the selected content. Because SteamDB may require browser access, **Open SteamDB** opens the matching manifest page when a direct request is not possible. A known manifest ID can still be entered directly.

### Platforms and architectures

Besides the Mac, Windows and Linux editions, Steam's platform choices include published Android depots. Android depots stay separate from the PC editions, and shared depots without a platform tag are downloaded with the selected platform. When automatic import is on, downloaded APKs go through the ordinary Android package import.

Steam's architecture choices are taken from depot restrictions and published executable metadata. For macOS, they distinguish 32-bit, 64-bit and Apple Silicon when the publisher declares them. An unspecified architecture stays unspecified, and shared game data is not labeled as a separate executable build. A depot marked 64-bit can come with an Apple Silicon executable. Android ARM64 is shown only when the publisher's CPU metadata specifies it, since an Android or 64-bit platform flag alone does not establish ARM64. For local Mac installations, the Mach-O slices of the executable identify Intel, Apple Silicon and universal binaries when they are available.

### Duplicates and destinations

Before transferring content to the default collection, MacLauncher compares the saved app, platform and exact version. If it finds a duplicate, a warning offers **Use existing copy**, **Download again** and **Cancel**. For Steam, the comparison uses the manifest IDs of the selected depots; for the other stores, it uses their published build, upload or installer IDs. Custom destinations count as separate collections. A hosted file without a stable revision identifier is never assumed to be an exact duplicate.

**Import into MacLauncher when the download finishes** starts checked, and clearing it downloads without adding a game to the library. The default destination is MacLauncher's own download folder, and **Choose folder…** selects a custom parent folder instead. Each download creates its own version folder and leaves existing installations untouched. Progress, cancellation, paths and import results stay visible in External, and completed content can be imported later. Archives and installers go through the ordinary import and preparation, and when no supported game can be added, the downloaded files stay available.

## Steam accounts

**Reuse Steam** works through the console of the running Mac Steam app and uses the account signed in there. Owned games and family-sharing licenses come from that session, and its credentials are not copied. Names, platforms and build information come from Steam's local metadata, and Steam may bring its window forward while it processes session commands. Steam downloads the requested depots into a temporary download folder kept apart from installed games, and MacLauncher then copies them into the selected destination. Once the copy is done and the download records are written, the temporary depot folders that this download created are removed, along with their app folder when it is empty. Depot folders that existed before, and temporary folders left by failed or interrupted copies, are kept. Cancelling stops that copy and the import, although Steam may continue its own transfer. Game metadata comes from Steam's local app cache. For missing information and explicit metadata refreshes, MacLauncher uses an anonymous Steam connection, without opening or bringing forward the desktop Steam app.

**Sign in manually** creates a separate Steam session inside External. Steam Guard codes and mobile or email approvals are handled in the window, and QR sign-in shows a locally generated code for the Steam challenge. The account selector at the top of the **Steam** tab lists several manual accounts alongside the Mac Steam account. Switching accounts changes the library being browsed, while downloads already started keep their original account. **Add account** opens another sign-in, and **Remove account** forgets that manual sign-in.

A remembered manual sign-in is stored as an encrypted refresh token protected by the macOS Keychain. Opening External lists the account names without accessing the Keychain, which is used only when a manual sign-in is connected or saved. Passwords are used to sign in and are never saved. Steam platform selection does not depend on the host Mac and includes published 32-bit Mac content. Private branches require access from the publisher and may require a manual sign-in.

## Epic, GOG and itch.io accounts

Epic and GOG can reuse supported local sign-ins from Heroic, Legendary or the store's own tools without changing their configuration. Manual sign-in opens the store's authorization page in the browser and accepts the code it returns. Epic downloads use a Legendary helper and GOG Galaxy builds a native GOGdl helper, and both helpers are downloaded automatically when a download needs them. **Runtimes → Tools → GOGdl** lists live upstream releases and installed versions, with Install, Delete, Set default and a custom executable or folder. A usable installed or custom GOGdl is reused offline. A missing helper downloads after consent; ordinary GOG use requires no manual setup. GOG also offers offline installers with their version, platform and language metadata. Each installer file is checked against the size and MD5 in the checksum record that GOG publishes for it, and it keeps the file name given in that record.

itch.io starts in **Public games** mode, where pasting the URL of a public itch.io game adds its downloadable uploads without an API key. Free and pay-what-you-want files remain subject to the publisher's access and pricing settings. Public pages offer upload editions, while earlier build archives need whatever access itch.io grants. A selected upload is never silently replaced with another edition. Added game links are cached locally, and the circular arrow reloads those pages only on request.

**Account library** uses an optional API key to list owned purchases, claims, gifts and bundles. **Save API key** starts unchecked, and a saved key stays encrypted until **Forget saved key** removes it. **Disconnect** clears the active session. API keys are sent in Authorization headers and never in request URLs. Switching to public mode does not delete a saved key.

## Android

The Android tab searches Google Play, F-Droid and IzzyOnDroid and shows each source's results as they arrive. Google Play uses browser sign-in by default, shared with **Settings → Android**, and an existing microG or Mac.apk account can be selected without opening an Android sign-in. Searching F-Droid and IzzyOnDroid needs no account. Purchase history, app search, device profiles and exact APK editions are described in [Android app downloads](GOOGLE_PLAY.md).

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

Each completed version holds download metadata recording its store, app, platform and exact version. Importing an installation registers its path without copying the installation into the per-game records folder. Settings and generated runtime data follow the usual [data layout](../development/DATA_MODEL.md).
