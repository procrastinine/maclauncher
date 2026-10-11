# CrossOver

CrossOver is an optional Windows backend supplied by an existing local [CrossOver application](https://www.codeweavers.com/crossover). MacLauncher discovers `/Applications/CrossOver.app` and `~/Applications/CrossOver.app` automatically. Runtimes → CrossOver → Add CrossOver registers additional applications, including previews and copies with updated libraries. Applications stay in their original locations. Remove unregisters a path without deleting the application.

Each application has an independent selection, even when several copies report the same version. Runtimes selects the default; the game's Version selector chooses a different application for that game. Find installed applications checks local paths without network access. CrossOver downloads, licenses and application updates remain handled by CodeWeavers.

## Import and Play

Drag in a Windows game folder or `.exe`, then choose CrossOver and Play. Games already detected as another supported engine also offer CrossOver when their content includes a Windows executable and a registered CrossOver application is available. Existing engine backends retain their defaults. After recognized formats have been checked, an unknown game uses CrossOver when the selected file is a Windows `.exe`, or the selected directory contains exactly one valid Windows executable at its top level. This fallback does not search subdirectories. A folder with multiple executables requires selecting the game's `.exe` directly. Native macOS app imports and Linux-only exports do not offer this backend. An unrelated neighboring Windows executable does not change their native format.

MacLauncher verifies executable headers rather than relying on the filename alone. x86 and x64 Windows executables are supported; DOS programs, DLLs, Windows ARM64 executables and installers requiring additional installation are outside this backend's playback support. Compatibility still depends on the game and selected CrossOver version. DRM, anti-cheat and missing Windows dependencies can prevent play.

Play automatically creates a private Windows bottle and private game files in the game's launcher data directory. Arbitrary Windows games can write settings or saves beside any asset, so the game folder is copied once using filesystem copy-on-write cloning when available. Other filesystems require storage for a separate copy. Relaunching checks source file metadata and reuses unchanged assets. Updated originals replace a private file only when its contents still match the previous original; saves, mod edits and private deletions remain intact. Newly added assets are copied, and files removed from the source remain in the private folder. Initial preparation records content hashes; later launches hash only changed candidates. Source folders and CrossOver applications remain unchanged. Forgetting a game removes its private files and bottles. Stop terminates Wine processes in that game's private bottle; cancelling initial preparation removes its incomplete environment so Play can retry.

Different registered applications and Windows environment types use separate bottles. Saves stored beside game files share the same private game folder; saves stored in a bottle's Windows profile remain with that bottle. Windows profile folder aliases into macOS Documents and Desktop are replaced with private directories. CrossOver does not supply a universal save editor or save-location format; engine save tools are unavailable while this backend is selected.

## Runtime Settings

Default settings and per-game overrides include:

- Graphics: Automatic, D3DMetal, DXMT, DXVK or WineD3D. Automatic preserves CrossOver's selection. Availability depends on the application, Mac and macOS version.
- Synchronization: Automatic, MSync, ESync for older versions, or Off. Newer CrossOver releases may no longer support ESync.
- Language locale: an optional locale identifier such as `ja_JP.UTF-8`.
- Windows environment: Windows 10, Windows 11, Windows 7 or Windows XP, using a 64-bit bottle when included by the selected application.
- Windows executable: an optional relative path when automatic selection chooses the wrong executable.
- Wine DLL overrides, environment variables and game arguments. These apply to the game process; application and bottle paths remain managed automatically.
- BepInEx winhttp override: opt in to `winhttp=n,b` for a game that already contains BepInEx's proxy DLL. No mod, DLL or font download occurs. Explicit Wine DLL overrides take precedence.

Graphics and synchronization behavior follow the [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index). The BepInEx option follows its [Wine instructions](https://docs.bepinex.dev/articles/advanced/proton_wine.html). A licensed CrossOver application and its own prerequisites remain required. Intel-only Wine components use the launcher's existing Rosetta check and installation consent flow, even when the CrossOver app itself is universal.

## Backend contract

CrossOver is registered as a runtime provider. Module discovery composes its runtime metadata and settings into detected Windows games without changing their engine identity. Offline detection records both positive and negative Windows executable evidence. Runtime support uses those cached facts and local application state; engine-specific preparation and runtime-download hooks do not run for a selected provider.

Application registrations live under `runtimes/crossover/registrations.json`. Game files, bottles and per-game records live under `games/<gameId>/runtimes/crossover/`. No CrossOver binaries are bundled, copied into runtime storage or downloaded by MacLauncher. Wine's macOS window driver requires a graphical login session, so native playback runs from the MacLauncher application. An SSH shell alone cannot supply that session. [NotProton](https://github.com/NotProtonNot/NotProton) demonstrates a separate Steam integration; this backend uses CrossOver's own commands and does not modify Steam or CrossOver.
