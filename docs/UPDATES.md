# App updates

MacLauncher can find, download and install newer versions of itself from the releases of its GitHub repository, [procrastinine/maclauncher](https://github.com/procrastinine/maclauncher/releases). It looks for a release only when **Check for Updates…** is chosen, or at launch when the **Check for updates at launch** setting is on. That setting is off by default.

## Checking for a newer release

**Check for Updates…** sits in the app menu, right after **About MacLauncher**, and the **Check for updates…** button in **Settings → Launcher** runs the same check. The check reads the repository's release list through MacLauncher's shared [request module for GitHub metadata](runtimes/GITHUB_TRANSPORT.md) and compares the newest release with the running version.

Releases are tagged `v<version>`, where the version is a [semantic version](https://semver.org/). Drafts, prereleases and tags of any other form are ignored, and build metadata after `+` does not make a version newer. The result appears in a native dialog:

- **MacLauncher is up to date** when no published release is newer than the running app.
- **MacLauncher X is available (current Y)**, with **Download and Restart**, **Release Notes** and **Later**. **Release Notes** opens the release page on GitHub.
- **MacLauncher could not check for updates**, with the reason, such as GitHub being unreachable or an HTTP error.

**Settings → Launcher** shows the latest result with the date and time of the check, and it keeps that result across restarts until a different version of MacLauncher runs. With **Check for updates at launch** turned on, the same check runs a few seconds after each start. Such a launch check shows a dialog only when a newer release is available, and when it fails, the failure is recorded in Settings without a dialog.

## Choosing the download

Each release has one app per Mac CPU, `MacLauncher.app.zip` for Apple Silicon and `MacLauncher-Intel.app.zip` for Intel, and a build manifest for each, `MacLauncher-arm64.build-manifest.json` and `MacLauncher-x64.build-manifest.json`. A manifest names its app archive, CPU, version, minimum macOS and SHA-256 checksum. How releases are published is described in [Releases](development/RELEASING.md#app-releases).

The CPU is taken from the running MacLauncher process, so the Intel app keeps receiving the Intel build even when it runs on Apple Silicon through Rosetta. MacLauncher reads the manifest for that CPU and uses it only when its CPU and version match the release. For a release without such a manifest, an archive whose file name states the CPU (`arm64`, `x64` or `universal`) is used, provided that GitHub lists its SHA-256.

When a release's app needs a newer macOS than the running one, or the release has no app for this CPU with a published SHA-256, no download is offered. Instead, the dialog gives the reason and offers the release page.

## Verification

Nothing is replaced until the download has passed these checks, in this order:

1. The archive's size and SHA-256 match the values GitHub lists for that release asset.
2. The archive's SHA-256 matches `appArchiveSha256` in the build manifest for this CPU. When GitHub's value and the manifest's value differ, no download is offered in the first place.
3. `ditto` extracts the archive into a folder beside the installed app, and the folder holds exactly one app.
4. The app's `CFBundleShortVersionString` is the release version, and its `CFBundleIdentifier` is the installed app's.
5. The app's main executable contains code for the running CPU.
6. `codesign --verify --deep --strict` accepts the app.

If any check fails, MacLauncher deletes the download and the extracted copy, leaves the installed app as it was and names the reason in a dialog and in Settings.

Together, these checks show that the app is the file published in the project's GitHub release for that version and CPU, that it arrived complete and unaltered, and that its contents still match its code signature. Because releases are signed ad hoc and not with a Developer ID, the signature check confirms that the bundle has not changed since it was signed but does not identify the signer. Packages from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) are trusted on the same basis, since their catalogs and SHA-256 values also come from GitHub over HTTPS.

Each release archive also carries a GitHub build attestation, a signed record of the source commit and workflow that built it. MacLauncher does not check that attestation itself, because doing so requires Sigstore signature verification; [Verifying MacLauncher](development/VERIFYING.md) shows how to check it with `gh attestation verify`.

## Installing

**Download and Restart** downloads the archive into `updates/downloads/` in MacLauncher's data folder. The Dock icon and the download menu show its progress, and the download menu can cancel it. While it downloads, **Check for Updates…** offers **Cancel Download**, and Settings shows the progress with the same button.

Once the download passes verification, the archive is deleted and the new app waits in a hidden `.MacLauncher-update-*` folder beside the installed app, on the same volume, while a dialog offers **Restart to Update** and **Later**. A waiting update stays ready after **Later** and after MacLauncher restarts. Both **Check for Updates…** and the Settings button then offer the restart, as **Restart to Update** in the dialog and **Restart to update** in Settings. Before anything is replaced, **Restart to Update** repeats checks 3 to 6 on the waiting app. If one of them fails, the waiting app moves to the Trash, the installed app stays as it was, and the dialog names the reason. While games started from MacLauncher are running, Restart to Update is held back, and its dialog explains that replacing the app would affect games that run from it.

**Restart to Update** then writes a short shell script to `updates/install-update.sh`, starts it as a separate process and quits MacLauncher. The script:

1. waits up to five minutes for the MacLauncher process to exit, and otherwise stops with the update still ready;
2. moves the installed app into the hidden update folder beside it;
3. moves the new app to the installed app's path, keeping its name and location, and puts the previous app back if that move fails; if the previous app cannot be put back either, the log names the folder that holds it;
4. moves the previous app to the Trash, with `/usr/bin/trash` on macOS 15 or later and otherwise into `~/.Trash`;
5. opens the app with `open`.

The script appends its messages to `updates/install.log` and does not touch the library, settings, saves or installed runtimes in the data folder. At the next start, MacLauncher moves any hidden update folder left over from an installed update to the Trash.

## When MacLauncher cannot replace itself

In the following cases, a newer release is still reported, but the dialog offers **Open Release Page** and **Later** instead of a download:

- MacLauncher runs from a source checkout (`pnpm dev`) instead of as a packaged app.
- macOS runs it from a temporary read-only copy, which macOS calls App Translocation. This happens to an app opened from the folder it was downloaded or unzipped into, and moving MacLauncher to the Applications folder and opening it from there ends it.
- MacLauncher cannot write to its app bundle or to the folder that holds it, as in `/Applications` for an account without administrator rights.
- The release has no app for this CPU with a published SHA-256, or its app needs a newer macOS.

## Files

All paths are relative to MacLauncher's data folder, which is `~/Library/Application Support/maclauncher/` by default.

| Path | Contents |
| --- | --- |
| `updates/last-check.json` | Time, outcome and versions of the latest check |
| `updates/staged.json` | The verified update waiting for Restart to Update: its version, CPU and folder |
| `updates/downloads/` | The archive while it downloads and is verified |
| `updates/install-update.sh` | The installation script that Restart to Update starts |
| `updates/install.log` | Messages from the installation script |

**Check for updates at launch** is stored as `launcher.checkForUpdatesAtLaunch` in `settings.json`, as the [data model](development/DATA_MODEL.md#launcher-settings) describes. The updater is implemented in `src/main/app-update.js`.
