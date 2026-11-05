# Android app downloads

The **External** window has an Android tab that searches Google Play, F-Droid and IzzyOnDroid. Each selected source runs independently and shows its results as soon as it responds. Google Play also lists the account's purchase history under **Owned library**, separately from the search results. That history requires a connected account, so until one is connected, **Owned library** is disabled and a note beside it asks for a Google account; a saved sign-in is shown before it connects.

**Add to library** acquires an app that Google Play confirms is free for the selected account, without downloading its APKs. The **Owned** tag appears once Google Play confirms the entitlement. Paid apps need an existing license, because MacLauncher never submits payment details or completes paid purchases.

## Search

Search accepts an app name, an Android package name or a supported store URL. A plain package name or a Google Play URL searches Google Play alone. An F-Droid or IzzyOnDroid app URL, or a package name prefixed with `fdroid:` or `izzy:`, searches that repository. Name searches use the selected sources. Repository search and downloads work without a Google account.

## F-Droid and IzzyOnDroid

An app's details in either repository list its published APK versions, with their version codes, CPU architectures and Android SDK requirements, from the repository's version-2 index. Architecture-independent APKs are available for every supported CPU profile. The exact selected APK is downloaded; an incompatible selection is rejected and never replaced with another version.

Search uses each repository's search service. Opening app details fetches the repository index when the local cache needs refreshing, and the index is checked against the size and SHA-256 hash in the repository's entry metadata. A download is checked against the APK's advertised SHA-256 hash, package name and exact version code, and keeps its original signature. These checks rely on HTTPS and the repository's hash metadata, and do not independently verify the repository's signing key or the APK publisher's certificate.

Repository downloads go to `external/downloads/fdroid/` or `external/downloads/izzy/` in the launcher profile. Custom destinations, background progress, cancellation, optional imports and exact-copy duplicate checks work as for the other External downloads. Each APK gets its own version folder containing `base.apk` and its download metadata.

## Accounts

Google accounts belong to one of two Android account providers, microG or Mac.apk. **External → Android** and **Settings → Android** show the same shared list of these accounts, and browser sign-in is the default in both windows. An existing microG or Mac.apk account can be selected without opening an Android sign-in window, and choosing one requests a scoped Google Play session through the account's original AccountManager and verified authenticator. A remembered selection stores a reference to the provider's account; it does not copy the provider's master token or private account database. When the Android account runtime, Java or the microG packages are missing, they are [downloaded like any runtime](../runtimes/README.md#downloads-and-offline-use).

### Browser sign-in

Browser sign-in opens a native Google account window, where Google handles passwords, two-factor authentication and account challenges. The authenticated session is then registered with the selected provider through its supported account API: the original microG Services package, verified by its publisher, or Mac.apk's public account bridge. The providers keep separate account stores, and both appear in both account views. Registration never edits a provider's private databases.

The browser account's token can be remembered in MacLauncher's encrypted session storage. Forgetting a saved browser account also clears its launcher browser session. Forgetting a provider selection leaves the Android account in place.

External → Android lists saved Google sign-ins from account metadata that is not secret, without unlocking the Keychain. **Use saved sign-in** unlocks the chosen session and authorizes Google Play directly. **Sign in in browser** opens or focuses the Google window before the device is prepared. Progress shows the Google challenge and the account authorization that follows as separate steps. The window can be reopened or cancelled, and errors name the step that recovers from them. Without an account, the section explains how to sign in.

### Connections

Catalog requests and APK transfers use a native desktop client. Registering or reusing a microG account uses the Android account service, which installs its components when they are missing. No separate Android store app is needed. Playing an imported app uses the ordinary Android runtime and service configuration.

## Versions and device profiles

Each request for the current version names a device profile: ARM64, ARMv7, x86-64 or x86. The Android SDK level is selected separately, from 21 to 36, and defaults to 34 for every architecture. Different profiles can receive different version codes or package splits. A profile's availability is checked when it is selected, and native ABI information comes from the split metadata when Google Play supplies it.

A known earlier version code can be entered under **Known version code**, and that control stays available when the current version is unavailable for a profile. Google Play does not expose a complete version history through this interface, and delivery remains subject to the account, the region and device compatibility. A requested version code is kept and checked against the manifest of each delivered APK, and an unavailable edition is never silently replaced with the latest version.

**Owned library** lists the apps in the account's purchase history. Some older or free apps may be missing from that history, and Search can find other apps. Large histories are read in pages up to a fixed limit, and the result is flagged as truncated when the limit is reached.

The base APK and its required splits stay separate, with their original signatures. **Include expansion files and asset packs** adds the available OBB expansions and asset packs; clearing it never removes required configuration splits. Downloaded APKs are checked against the integrity hashes that Google Play supplies, and their package names and version codes must match the requested app.

## Storage and imports

Default downloads go to `external/downloads/google-play/` in the launcher profile, each in its own folder grouped by package, device architecture and exact version. A custom destination also receives a new version folder, and existing installations are kept. The duplicate check for the default location compares the version code, architecture, Android SDK level, language and additional-files selection.

The completed folder contains `base.apk`, the split APKs next to it and any `Android/obb/<package>/` expansions. Importing `base.apk` uses the ordinary Android package-set import, which includes the matching splits next to it. The download metadata and the shared External index keep the import entry for later. Clearing the import option keeps the download without adding a game to the library.

## Component reference

| Component | Behavior |
| --- | --- |
| [Android source service](../../src/modules/android/store/aggregate.js) | Source selection, concurrent searches with independent results, and routing to Google Play or a repository |
| [Repository service](../../src/modules/android/store/repositories.js) | F-Droid and IzzyOnDroid search, verified index caches, exact APK selection and downloads |
| [Repository index reader](../../src/modules/android/store/repository-index-worker.js) | Reads selected package metadata outside the main process event loop |
| [Store service](../../src/modules/android/store/downloads.js) | Account connection, purchase-history cache, search, version selection, background transfers and imports |
| [Play protocol](../../src/modules/android/store/protocol.js) | HTTPS device registration, scoped authorization, details, search, purchase history, free acquisition and delivery |
| [APK identity reader](../../src/modules/android/store/apk-identity.js) | ZIP and binary `AndroidManifest.xml` identity checks, within size limits, without Java or an Android runtime |
| [Shared account adapter](../../src/modules/android/store/microg-accounts.js) | Cached provider accounts, account refresh, scoped session acquisition and browser-session registration |
| [Android account caller](../../src/modules/android/store/custom-account-token.js) | Supervised original Companion and Services APKs, private control pipes and Android AccountManager calls |
| [Account control overlay](../../src/modules/android/store/java/maclauncher/android/AccountControl.java) | Publisher and caller checks, scoped token retrieval, refresh invalidation and authenticated account registration |
| [Authenticator account policy](../../src/modules/android/store/java/maclauncher/android/framework/HostAccountAccess.java) | Original authenticators manage their registered account types, while applications keep the restriction to the selected account |
| [Shared host account manager](../../src/modules/android/store/google-account-manager.js) | Shared sign-in for Settings and External, encrypted persistence, provider registration and matching account removal |
| [Google browser sign-in](../../src/modules/android/store/google-play-auth.js) | Isolated persistent Google browser session and native HTTPS token exchange |

`createGooglePlayDownloads(options)` exposes `snapshot`, `connect`, `disconnect`, `loadLibrary`, `search`, `getVersions`, `addToLibrary`, `download`, `cancel`, `markImported` and `dispose`. Host callbacks supply browser sign-in, account-provider sessions, encrypted session storage and imports of completed downloads.

- `getVersions` accepts the requested architecture, `androidSdk` and language, and returns structured profile availability with its version catalog.
- `addToLibrary` accepts a package name and the same profile options.
- `download` accepts an exact `versionCode`, the architecture, `androidSdk`, language, destination, `includeExtras` and `autoImport`.

Constructing the service reads saved local metadata without connecting to Google Play. Network requests follow explicit account, search, refresh or download actions.

`createAndroidStoreDownloads(options)` combines the Google Play service with both repositories. Its search state records the request ID, the query, the results and each source's completion or error status. A new request cancels the previous search, and one source's failure does not discard another source's results. Repository rows use IDs qualified by their source for selection, while completed download metadata keeps the original Android package name.

## References

Repository metadata follows the [F-Droid API reference](https://f-droid.org/en/docs/All_our_APIs/) and the [IzzyOnDroid API reference](https://izzyondroid.org/about/resources/apis/).

Protocol fields are documented by [Aurora GPlayAPI 3.6.4](https://gitlab.com/AuroraOSS/gplayapi/-/tree/18ec2bd74995d30e500b756359a4de3e37976f03) and the [gplaydl 4.2.1 package](https://pypi.org/project/gplaydl/4.2.1/). Both serve only as protocol references, and neither is included. APK manifests use Android's [version code](https://developer.android.com/studio/publish/versioning) and [split package](https://developer.android.com/guide/app-bundle) names.

The included account-control JAR is MacLauncher's own adaptation of the maclauncher-android account control, at a recorded commit, and keeps its MIT license. Its [MacLauncher Builds recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/android-launcher/build.mjs) compiles it on GitHub against a fixed Android API version, and ordinary account actions use this included build. microG's authenticated session format follows its [LoginActivity](https://github.com/microg/GmsCore/blob/v0.3.17.252432/play-services-core/src/main/java/org/microg/gms/auth/login/LoginActivity.java) and [AuthManager](https://github.com/microg/GmsCore/blob/v0.3.17.252432/play-services-core/src/main/java/org/microg/gms/auth/AuthManager.java) account APIs.
