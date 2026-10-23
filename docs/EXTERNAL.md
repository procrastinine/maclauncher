# External game libraries

**External** beside Settings opens a separate native window for installed games
and store downloads. Reopening External focuses the existing window. The library
remains usable while imports and downloads run.

## Installed games

Installed aggregates Steam, Epic Games, GOG and itch.io games in common macOS and
CrossOver locations. It reads local store manifests, registered Steam libraries,
Heroic and Legendary installation records, GOG game metadata and itch.io install
receipts. Independently downloaded versions appear in **Downloaded**.
Scanning and the reload button stay offline. Installed artwork comes from local files.

Rows show the game, store, location, Mac, Windows or Linux platform, local version
information and import status. A human-readable version appears when recorded by
the store; otherwise a known content build is labelled **Build**. Missing version
information is shown as a dash. Search, sorting and store, platform and import
filters narrow the table. Checkboxes select games; Shift-click selects a range and the header
checkbox selects visible games while retaining selection outside the filter.

**Import** queues selection in the background. Existing installations stay in
place, the library updates as imports complete, and External keeps its focus.
Imported tags follow the registered game paths, including selected app bundles or
executables inside a store's game folder.

## Downloaded copies

**Downloaded** lists the independently stored versions recorded by MacLauncher,
including custom locations. This offline view remains available after restarting
the app and has its own selection and import controls. These copies are separate
from store-managed installations and are not updated automatically. Each download
keeps its exact content identity; downloading another edition creates a new folder.

**Open downloads in Finder** opens the default collection. Each store's destination
controls also offer **Open default in Finder** for that store's folder.

## Download tabs

Steam, Epic, GOG, itch.io and Android have separate tabs. Opening a tab reads cached data;
connection, reload, version refresh and download actions request network
access as needed. Account and version metadata are cached. Each selected game
has explicit version/build, platform and language controls where supplied by the
store. Library filters include platform tags and Steam ownership; sorting changes
the visible order without clearing selection. Question-mark buttons hold the
explanations for account modes, version limits and download locations. Circular
arrow buttons reload the adjacent list or version catalog.
Downloaded content remains subject to account and publisher access rules.
Downloading a platform does not establish MacLauncher runtime compatibility.

| Store | Version selection |
| --- | --- |
| Steam | Publisher branches, build IDs, individual depot manifests, previously observed manifests and exact historical manifest IDs |
| Epic | Published platform builds and an optional exact historical manifest URL |
| GOG | Available offline installer versions and Galaxy content builds, including previous builds returned by GOG |
| itch.io | Public upload editions from game links; account access also exposes individual builds, including available earlier builds |
| Google Play | Current versions for selected Android device profiles and exact known version codes, with required APK splits |
| F-Droid and IzzyOnDroid | Published APK versions with exact hashes, CPU architectures and Android SDK requirements |

Steam and Epic do not provide a complete historical catalog through these
interfaces. Known historical manifests can be entered explicitly; removed or
restricted content remains subject to store authorization. An explicit version
selection is preserved for the download and is not silently replaced with the
latest release.

**Fetch previous versions** requests SteamDB manifest history only for the chosen
game's selected depots. Results are cached by game and depot, retaining full
manifest IDs and available dates. Fetching history adds choices without changing
the selected content. SteamDB may require browser access; **Open SteamDB** opens
the corresponding manifest page when a direct request is unavailable. A known
manifest ID can still be entered directly.

Steam platform selection includes published Android depots alongside Mac, Windows
and Linux editions. Android depots remain separate from PC editions; untagged
shared depots accompany the selected platform. Downloaded APKs use the ordinary
Android package import flow when automatic import is enabled.

Steam architecture choices use depot restrictions and published executable
metadata. macOS distinctions include 32-bit, 64-bit and Apple Silicon
when declared. Unspecified architecture stays unspecified; shared game data is
not labelled as a separate executable build. A depot marked 64-bit can accompany
an Apple Silicon executable. Android ARM64 is shown when publisher CPU metadata
specifies it; an Android or 64-bit platform flag alone does not establish ARM64.
Local Mac installations use executable Mach-O slices
when available to identify Intel, Apple Silicon and universal binaries.

Before transferring content to the default collection, MacLauncher checks its saved
app, platform and exact version identity. A duplicate warning offers **Use existing
copy**, **Download again** and **Cancel**. Steam comparisons use the selected depot
manifest IDs; other stores use their published build, upload or installer identity.
Custom destinations remain separate collections. A hosted file without a stable
revision identifier is not assumed to be an exact duplicate.

**Import into MacLauncher** starts checked and can be cleared to download without
registering a game. Managed storage is the default; **Choose folder** selects a
custom destination parent. Downloads create separate version folders and preserve
existing installations. Progress, cancellation, paths and import results remain
visible in External. Completed content can be imported later. Compatible archive
or installer imports use the ordinary import and preparation flow; the downloaded
files remain available when no supported game can be registered.

## Steam accounts

**Reuse Steam** uses the running Mac Steam app's signed-in account through its
console. Owned games and family-sharing licenses come from that session; its
credentials are not copied. Steam's local metadata supplies names, platforms and
build information. Steam may activate its window while processing session commands.
Steam stages requested depots separately from installed games;
MacLauncher publishes a copy into the selected destination. Cancelling stops
MacLauncher publication and import; Steam may continue its own staged transfer.
Game metadata is read from Steam's local app cache; missing information and
explicit metadata refresh use an anonymous Steam connection without opening or
foregrounding the desktop Steam app.

**Sign in manually** creates an independent Steam session in External. Steam Guard
codes and mobile or email approvals are handled in the window. QR sign-in shows
a locally generated code for the issued Steam challenge. Multiple manual accounts and the Mac Steam
account appear in the account selector. Switching accounts changes the browsed
library while existing downloads retain their original account. **Add account**
opens another sign-in and **Remove account** forgets that manual sign-in.

Remembered manual sign-ins store encrypted refresh tokens using macOS Keychain
protection. Opening External lists account names without accessing the Keychain;
connecting or saving a manual sign-in accesses its encrypted credentials.
Passwords are used for sign-in and are not saved. Steam platform
selection is independent of the host Mac, including published 32-bit Mac content.
Private branches require publisher access and may require manual sign-in.

## Epic, GOG and itch.io accounts

Epic and GOG can reuse supported local Heroic, Legendary or store-tool sign-ins
without changing the original configuration. Manual sign-in opens the store's
browser authorization page and accepts its returned code. Epic downloads use an
automatically acquired Legendary helper; GOG Galaxy builds use an automatically
acquired native GOGdl helper. Helpers are shared internal tools and do not add
runtime-management tabs. GOG also exposes offline installers with their version,
platform and language metadata.

itch.io starts in **Public games** mode. Pasting a public itch.io game URL adds
its available downloadable uploads without an API key. Free and
pay-what-you-want files remain subject to the publisher's access and pricing
settings. Public pages expose upload editions; previous build archives require
the access supplied by itch.io. A selected upload is not silently replaced with
another edition. Added game links are cached locally, and the circular arrow
reloads those pages only on request.

**Account library** uses an optional API key for owned purchases, claims, gifts
and bundles. **Save API key** starts unchecked. A saved key is encrypted;
**Forget saved key** removes it. Disconnect clears the active session. API keys
are sent in Authorization headers rather than request URLs. Switching to public
mode does not delete a saved key.

## Storage

The Android tab searches Google Play, F-Droid and IzzyOnDroid, showing each source's
results as they arrive. Google Play uses browser sign-in by default, shared with Settings → Android.
Existing supported provider accounts remain selectable without opening Android
sign-in. Repository search works without an account. Purchase
history, app search, device profiles and exact APK editions are described in
[Android app downloads](GOOGLE_PLAY.md).

`userData` normally resolves to `~/Library/Application Support/maclauncher/`.

| Location | Contents |
| --- | --- |
| `external/downloads/steam/` | Managed Steam content, separated by app, platform and version |
| `steam/accounts/` | Separate manual-account metadata caches |
| `steam/session.enc` | Optional encrypted manual Steam sign-ins |
| `steam/installations.json` | Completed Steam downloads, including custom locations |
| `external/downloads/<store>/` | Separate managed Steam, Epic, GOG, itch.io, Google Play, F-Droid and IzzyOnDroid versions |
| `external/installations.json` | Completed external downloads, including custom locations |
| `external/tools/` | Shared versioned download helpers |
| `external/<store>/session.enc` | Optional encrypted store session or API key |
| `external/itch/public/library.json` | Cached public itch.io game links and metadata |

Download metadata inside each completed version records its store, app, platform
and version identity. Importing an installation registers its path without copying
it into the per-game records directory. Settings and generated runtime data retain
the normal [data layout](DATA_MODEL.md).
