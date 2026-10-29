# Runtime distribution

MacLauncher includes the launcher and its internal dependencies. Game engines and versioned game tools install separately. MacLauncher Builds supplies the MacLauncher-adapted packages; other managers use compatible publisher downloads.

MacLauncher owns the library UI, detection, settings and runtime installation.
MacLauncher Builds owns custom package production, corresponding source and published
catalogs. The launcher reads version catalogs and downloads binary packages
through their public URLs. Builds recipes use the source and dependencies
declared in the Builds checkout. Ordinary launcher use requires neither checkout;
package production does not require the sibling launcher checkout or its
Electron and React dependencies.

## Distribution policy

MKXP-Z, Adobe Flash Player and individual VN engines are managed downloads. Required MacLauncher patches stay in the packages published by MacLauncher Builds. They do not require a bundled engine fallback or a local compiler.

Import → Play checks the selected runtime. A missing runtime prompts for download consent, installs automatically and resumes Play. Tool actions use the same preparation flow. Installed versions work offline and are shared between games; saves, accounts and writable game data remain separate.

Available download lists start empty. Refresh discovers versions and caches the result locally; opening Runtimes or a dropdown reads only that cache. Refresh replaces the available list without installing an update or changing a saved selection. Installed versions remain available offline, including versions no longer offered for download. Explicit game and default version selections remain exact.

Each download source has its own version selector, link and Install action. MacLauncher Builds and upstream macOS downloads appear separately. When only Builds supplies Mac binaries, its package page is the primary link and upstream code is a secondary reference. Incompatible runtime families use separate subtabs, including Ren'Py 7/8, LÖVE 11/12 and HashLink ABI profiles.

### MacLauncher Builds downloads

| Project | Runtime or tool |
| --- | --- |
| ai5 | AI5 SDL2 |
| android | MacLauncher Android common JVM runtime |
| android-art | Android ART adapter |
| android-aim | AIM adapter |
| butterscotch | Butterscotch |
| flash-projector | Universal Adobe Flash Player |
| fna | FNA and its matching .NET/native dependencies |
| gemrb | GemRB |
| gm8-decompiler | GameMaker 8 decompiler |
| hashlink | HashLink ABI profiles |
| impacto | Impacto |
| krkrsdl2 | Kirikiri SDL2 with its KAG3 scripts and font |
| mkxpz | MKXP-Z with MacLauncher filename fixes |
| npengine | NP Engine |
| onscripter-en | ONScripter-EN |
| onsyuri | ONScripter-Yuri Mac builds |
| opengmk | OpenGMK |
| reminori | ReMinori |
| rlvm-adapter | MacLauncher Cocoa integration library for the upstream RLVM app |
| siglus | siglus_rs with its native host |
| sys3-decompiler | System 3 decompiler |
| system3 | System 3 SDL2 |
| vnds-love | VNDS-LOVE interpreter for LÖVE |
| vulkan-kosmickrisp-gles32 | KosmicKrisp GLES 3.2 graphics provider |
| xsys35-decompiler | System 3.5 decompiler |
| xsystem35 | xsystem35 |
| xsystem4 | xsystem4 |

Runtimes groups related managers and ABI profiles into their module panels. Downloads retain the complete compatible dependency closure and required notices. Managed packages can contain native libraries as well as executables.

The RLVM Mac app downloads from upstream. Its MacLauncher adapter is a separate managed Builds library; verified adapter copies in earlier installations remain usable offline. ScummVM uses its publisher's checksum-verified disk image and receives local ad-hoc signatures during installation for graphics integration; its installed record verifies the signed result offline.

Other managed providers include NW.js, Ren'Py, Godot, LÖVE, Java, Ruffle, ScummVM, RFVP, mac32, Mac.apk and compatible official GameMaker tools. Decompilers and asset tools follow their module's managed provider. Optional authenticated upstream downloads, including MKXP-Z GitHub Actions versions through gh, remain separate from public MacLauncher Builds downloads.

### Included components

Python, 7-Zip and evbunpack are internal import/extraction dependencies. Python and 7-Zip use pinned upstream macOS binaries; evbunpack uses its pinned upstream source. They are bundled directly without Builds staging. The custom innoextract Mac build is a managed Builds package listed in Runtimes → Tools → Installer reader. Import and RTP preparation download a missing selected reader after consent and continue; installed copies remain available offline. Managed package installation verifies archive and file hashes, native CPU slices, signatures and macOS requirements.

The following MacLauncher Builds components are included as launcher integration code:

| Project | Purpose |
| --- | --- |
| android-apk-metadata | APK metadata extraction during import |
| android-launcher | Android launcher metadata, argument and input adapters, account integration and APK signature verification |
| android-privacy | Native Android privacy and platform integration |
| catsystem2-kif-crypto | KIF archive cryptography for asset tools |
| gamemaker-opengl-helper | Software OpenGL integration for compatible GameMaker runners |
| ios-playtools-paths | PlayTools storage/path adaptation |
| java-steamworks | Matching Java Steam JNI adapters |
| love-luasteam | Lua/LuaJIT Steam integration |
| mkxpz-config-helper | Per-game MKXP-Z configuration isolation |
| reshade | Core graphics host, FX compiler and shader integration |
| rpgmaker-decrypter | RPG Maker archive and asset extraction |
| steam-api-helper | Shared Steam compatibility ABI |
| steam-ticket-loader | Steam ticket integration |
| web-renderer-network | Browser game network isolation |

These components are not standalone game engines. Their versions and architecture mappings are selected by the launcher. The app contains only the required helper profiles, not their entire release histories. Launcher scripts and UI remain launcher source. Siglus, RLVM, KAG3 and AIM adaptations are consumed from their managed packages. Kawariki scripts, their launcher overlay and RPG Maker NW.js files are bundled with the launcher and require no separate installation. VNDS-LOVE is installed alongside its selected LÖVE host through the ordinary Play flow.

## Catalog and installation contract

MacLauncher Builds publishes one schema-2 catalog per project under `catalogs/<project>.json`. A catalog records exact package versions, architecture support, minimum macOS, immutable release tags, asset names, byte lengths and SHA-256 checksums. Tags use `<project>/v<version>/<arch>`. A release contains the binary archive for that project.

Packages based on a tagged upstream version use `<upstream-version>-MCLvN`; the revision starts at one for each new upstream version. Commit-only upstreams use `MCLvN-MMDD`, with an increasing numeric revision across commits and calendar years; the date comes from the selected upstream commit. Exact commits and full dates remain in package metadata. MacLauncher-owned components use their own version. The package revision is separate from the upstream program's embedded version, which remains unchanged.

A project can list several versions, including several revisions of one upstream version. Each version is a separate download and installation; installing a later revision leaves earlier ones installed. Each compatible version appears in its source's version selector, and each installed version has its own Uninstall and **Set default** actions. A version chosen for a game in the inspector takes precedence, followed by the version the game's data recommends and then the default. Without these, Play reuses the newest installed compatible version, as described in [Runtime selection flow](RUNTIMES.md#runtime-selection-flow).

The [package index](https://procrastinine.github.io/maclauncher-builds/) lists published downloads and compatibility profiles. The launcher discovers each project's catalog through an explicit Refresh, Install or consented Play and validates its package identities; it does not include a preloaded download list. Each record describes its own source revision and the capabilities its module reads, such as a native API, feature list or supported data versions. The module matches games against those capabilities; a stock upstream release does not replace a required adaptation.

Each catalog record is validated separately. A record that the launcher cannot install stays in the version selector with its reason, and the project's other versions remain available. A record with a later record schema, a `launcherContract` above the one the launcher implements for that project, or an architecture the launcher does not know reads "Requires a newer MacLauncher." `launcherContract` is a positive integer that defaults to 1; a project raises it only when a package depends on launcher behavior that earlier launchers lack. Added record fields need no new contract and are ignored by launchers that do not use them. A record for a runtime adapted from an upstream source names that repository and revision in `source`, and its `capabilities` object lists the facts that its module uses to match games. A later record that names its source is installable without a launcher update; a record that identifies no source revision is listed with that reason.

Installation verifies the selected archive, extracts into a private staging directory, checks the actual wrapper and payload layout, verifies file identities and native signatures, and publishes the complete installation atomically. Cancellation removes an incomplete stage. Existing installed versions and explicitly imported compatible runtimes remain usable.

Runtime minimum macOS values are lower bounds. A requirement such as 27.0 accepts later compatible releases, including 27.1 and 27.2. The launcher minimum is macOS 13; individual providers can require a newer host. Architecture and game ABI selection remain explicit, including Intel profiles that require Rosetta.

Android common, ART and AIM are separate managed packages. Android SDK system images are acquired separately after confirmation. Java is managed when required. Mac.apk uses its publisher releases. The Android adapters retain their matching framework, JNI and native source profiles.

## Application assembly

[`build/runtime-packages.json`](../../build/runtime-packages.json) selects the included integration packages. Game engines and external tools download separately. The application workflow downloads the exact selected helper packages before building the app.

The lock command selects the exact included helper packages from public catalog inputs. This build input does not populate Runtimes download lists:

    node scripts/runtime-packages.cjs lock <catalog-directory>

scripts/distribution-model.cjs derives the resource plan from module declarations. scripts/runtime-content.cjs excludes test runners, fixtures and generated test outputs from development renderer serving and application packaging. Embedded source archives follow the same boundary.

[`scripts/app-inputs.cjs`](../../scripts/app-inputs.cjs) checks the normalized packaging selectors against actual ASAR, unpacked and resource files. Each file maps to launcher source, a pinned upstream supplier, exact locked source dependencies or a sealed custom Builds record. Renderer outputs retain their consumed source and configuration identities. Unknown inputs, extra files and source changes during assembly fail packaging.

Native staging applies each module's payload policy before signing and inventory. Executables, dependency libraries, runtime resources and license notices remain in the binary package. Producer build helpers remain in the source repository.

Native payloads are sealed before application signing. Copying and signing preserve their declared bytes and permissions. Final package checks compare the source plan, native inventory, .app and .zip; a previously checked artifact does not describe a later build.

    pnpm package:check -- source --arch arm64 --maximum-macos 13.0
    pnpm package:mac --arm64

The final artifact check also supplies the app path, native inventory, archive and archive SHA-256. The launcher release asset is MacLauncher.app.zip. See [CI](../CI.md) for the application workflow.

## Source and licenses

Each MacLauncher Builds release tag points to the source commit containing its pinned upstream inputs, owned patches and build recipes. Source code is available through that commit on GitHub. Binary release assets do not require additional source archives, receipts or manifest attachments.

Catalog metadata and the in-package manifests serve installation and integrity checks. Required license notices remain with the corresponding binaries. Android system images and proprietary developer SDKs follow their own acquisition and redistribution terms.

Upstream checkouts are pinned and read-only. Owned adaptations are applied during the build; working publisher binaries are reused when a rebuild provides no required capability or compatibility fix. [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) contains the producer recipes.
