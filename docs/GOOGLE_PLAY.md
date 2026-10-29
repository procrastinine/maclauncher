# Android app downloads

The Android tab in External searches Google Play, F-Droid and IzzyOnDroid. Selected
sources run independently and show results as each source responds. Google Play
also browses account purchase history. Search results remain separate from
account purchases. **Add to library** acquires a confirmed free Google Play app
for the selected account without downloading its APKs. The owned tag appears
after Google Play confirms entitlement. Paid apps require an existing
license; MacLauncher does not submit payment details or complete paid purchases.

Search accepts an app name, Android package name or supported store URL. A plain
package name or Google Play URL searches Google Play alone. An F-Droid or
IzzyOnDroid app URL, or a package name prefixed with `fdroid:` or `izzy:`, selects
that repository. Name searches use the selected sources. Repository search and
downloads remain available without a Google account.

## F-Droid and IzzyOnDroid

Repository app details list the published APK versions, version codes, CPU
architectures and Android SDK requirements from each repository's version-2
index. Architecture-independent APKs remain available for all supported CPU
profiles. The exact selected APK is downloaded; an incompatible selection is
rejected rather than replaced with another version.

Search uses each source's search service. Opening app details fetches the
repository index when its local cache needs refreshing. The index is checked
against the size and SHA-256 advertised by the repository's entry metadata.
Downloads verify the APK's advertised SHA-256, package name and exact version
code, retaining its original signature. These checks use HTTPS and repository
hash metadata; they do not independently verify the repository's signing key or
the APK publisher's certificate.

Repository downloads use `external/downloads/fdroid/` or
`external/downloads/izzy/` beneath the launcher profile. Custom destinations,
background progress, cancellation, optional imports and exact-copy duplicate
checks follow the same External download controls. Each APK receives a separate
version folder containing `base.apk` and its download metadata.

## Accounts

Browser sign-in is the default in both External → Android and Settings → Android.
Both windows show the same shared account list. Existing microG and Mac.apk
Google accounts remain selectable without opening an Android sign-in window.
Choosing an existing account requests a scoped Google Play session through its original
AccountManager and verified authenticator. A remembered selection stores the
provider account reference; it does not copy the provider's master token or
private account database. Required Android account runtime, Java and microG
packages follow the ordinary download consent flow when absent.

Browser sign-in opens a native Google account window. Google handles passwords,
two-factor authentication and account challenges in that window. Its authenticated
session is registered with the selected provider through its supported account
API: the original, publisher-verified microG Services package or Mac.apk's
public account bridge. Provider account stores remain separate and both are
available in both account views. Registration does not edit private provider
databases. The resulting browser
account token can be remembered using MacLauncher's encrypted session storage.
Forgetting a saved browser account clears its launcher browser session as well.
Forgetting a provider selection leaves the Android account in place.

External → Android lists saved Google sign-ins from non-secret account metadata without
unlocking the Keychain. **Use saved sign-in** unlocks that session when chosen and authorizes
Google Play directly. **Sign in in browser** opens or focuses the Google window before device
preparation. Progress distinguishes the Google challenge from the account authorization that
follows; the window can be reopened or cancelled, and errors name the recovery step. With no
account, the section shows how to sign in.

Catalog requests and APK transfers use a native desktop client. Registering or
reusing a microG account uses the Android account service, with installation
confirmation when its components are absent. A separate Android store app is
not required. Playing an imported app uses the ordinary Android runtime and
service configuration.

## Versions and device profiles

The current version is requested for a selected ARM64, ARMv7, x86-64 or x86 device
profile. Android SDK level is selected independently, from 21 through 36; the
default is 34 for every architecture. Different profiles can receive different
version codes or package splits. Profile availability is checked when selected. Native ABI
information comes from split metadata when supplied by Google Play. An unavailable
current profile leaves the known-version-code control available for an explicit
historical request. A known earlier Android version code can also be entered. Google Play
does not expose a complete historical version list through this interface;
delivery remains subject to account, region and device compatibility. A requested
version code is preserved and checked against each delivered APK's manifest.
An unavailable edition is not silently replaced with the latest version.

Account rows come from purchase history. Some earlier or free acquisitions may
be absent; Search can locate additional apps. Large histories are read in bounded
pages and retain a truncation flag when that limit is reached.

The base APK and required splits remain separate, with their original signatures.
Additional files include available OBB expansions and asset packs. The additional
files option does not remove required configuration splits. Downloaded APKs are
checked against the integrity hashes supplied by Google Play, and package names
and version codes must match the requested app.

## Storage and imports

Default downloads use `external/downloads/google-play/` beneath the launcher
profile, grouped by package, device architecture and exact version. Each download
has its own folder. A custom destination also receives a new version folder;
existing installations are preserved. Default duplicate comparisons include the
version code, architecture, Android SDK level, language and additional-files selection.

The completed folder contains `base.apk`, adjacent split APKs and any
`Android/obb/<package>/` expansions. Importing `base.apk` uses the ordinary Android
package-set flow, which retains matching adjacent splits. Download metadata and
the shared External index keep this import entry for later use. The import option
can be cleared to keep an independent download without registering a game.

## Component reference

| Component | Behavior |
| --- | --- |
| [Android source service](../src/modules/android/store/aggregate.js) | Source selection, concurrent searches with independent results, and routing to Google Play or a repository |
| [Repository service](../src/modules/android/store/repositories.js) | F-Droid and IzzyOnDroid search, verified index caches, exact APK selection and downloads |
| [Repository index reader](../src/modules/android/store/repository-index-worker.js) | Reads selected package metadata outside the main process event loop |
| [Store service](../src/modules/android/store/downloads.js) | Account connection, purchase-history cache, search, version selection, background transfers and imports |
| [Play protocol](../src/modules/android/store/protocol.js) | HTTPS device registration, scoped authorization, details, search, purchase history, free acquisition and delivery |
| [APK identity reader](../src/modules/android/store/apk-identity.js) | Bounded ZIP and binary AndroidManifest.xml identity checks without Java or an Android runtime |
| [Shared account adapter](../src/modules/android/store/microg-accounts.js) | Cached provider identities, account refresh, scoped session acquisition and browser-session registration |
| [Android account caller](../src/modules/android/store/custom-account-token.js) | Supervised original Companion and Services APKs, private control pipes and Android AccountManager calls |
| [Account control overlay](../src/modules/android/store/java/maclauncher/android/AccountControl.java) | Publisher and caller checks, scoped token retrieval, refresh invalidation and authenticated account registration |
| [Authenticator account policy](../src/modules/android/store/java/maclauncher/android/framework/HostAccountAccess.java) | Original authenticators manage their registered account types while applications retain selected-account restrictions |
| [Shared host account manager](../src/modules/android/store/google-account-manager.js) | Common Settings and External sign-in, encrypted persistence, provider registration and matching account removal |
| [Google browser sign-in](../src/modules/android/store/google-play-auth.js) | Isolated persistent Google browser session and native HTTPS token exchange |

`createGooglePlayDownloads(options)` exposes `snapshot`, `connect`, `disconnect`,
`loadLibrary`, `search`, `getVersions`, `addToLibrary`, `download`, `cancel`, `markImported` and
`dispose`. Host callbacks supply browser sign-in, account-provider sessions,
encrypted session storage and completed-download imports. `getVersions` accepts
the requested architecture, `androidSdk` and language, and returns structured
profile availability alongside its version catalog. `addToLibrary` accepts a
package name and the same profile options. `download` accepts an exact
`versionCode`, architecture, `androidSdk`, language, destination, `includeExtras` and
`autoImport` selection. Construction reads saved local metadata without connecting
to Google Play; network requests follow explicit account, search, refresh or
download actions.

`createAndroidStoreDownloads(options)` combines the Google Play service with both
repositories. Its search state records the request ID, query, results and each
source's completion or error status. A new request cancels the preceding search;
one source's failure does not discard another source's results. Repository rows
use source-qualified IDs for selection, while completed download metadata retains
the original Android package name.

Repository metadata follows the
[F-Droid API reference](https://f-droid.org/en/docs/All_our_APIs/) and
[IzzyOnDroid API reference](https://izzyondroid.org/about/resources/apis/).

Protocol field identities are documented by
[Aurora GPlayAPI 3.6.4](https://gitlab.com/AuroraOSS/gplayapi/-/tree/18ec2bd74995d30e500b756359a4de3e37976f03)
and the [gplaydl 4.2.1 package](https://pypi.org/project/gplaydl/4.2.1/).
These are protocol references rather than included dependencies. APK manifests
use Android's [version code](https://developer.android.com/studio/publish/versioning)
and [split package](https://developer.android.com/guide/app-bundle) identities.

The included account-control JAR is an owned adaptation of the pinned
maclauncher-android account control and retains its MIT license. Its
[build recipe](../src/modules/android/store/build-account-control.mjs) compiles
against the selected Android runtime; ordinary account actions use the included
artifact. microG's authenticated session representation follows its
[LoginActivity](https://github.com/microg/GmsCore/blob/v0.3.17.252432/play-services-core/src/main/java/org/microg/gms/auth/login/LoginActivity.java)
and [AuthManager](https://github.com/microg/GmsCore/blob/v0.3.17.252432/play-services-core/src/main/java/org/microg/gms/auth/AuthManager.java)
account APIs.
