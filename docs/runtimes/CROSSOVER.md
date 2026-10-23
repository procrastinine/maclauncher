# CrossOver

CrossOver is an optional Windows backend supplied by an existing local [CrossOver application](https://www.codeweavers.com/crossover). MacLauncher discovers `/Applications/CrossOver.app` and `~/Applications/CrossOver.app` automatically. Runtimes → CrossOver → Add CrossOver registers additional applications, including previews and copies with updated libraries. Applications stay in their original locations. Remove unregisters a path without deleting the application.

Each application has an independent selection, even when several copies report the same version. Runtimes selects the default; the game's Version selector chooses a different application for that game. Find installed applications checks local paths without network access. CrossOver downloads, licenses and application updates remain handled by CodeWeavers.

An application updated in the same location retains its selection and existing bottles. A missing selected application does not silently switch to another copy. Restore it to its registered location, or add its new location in Runtimes and select that application.

[Sikarugir (Wine)](SIKARUGIR.md) is the separately managed Windows runtime and the
default for generic Windows games. CrossOver remains a local application choice;
saved CrossOver selections and known engines' usual defaults are preserved.

## Import and Play

Windows game folders and `.exe` imports offer CrossOver in the runtime selector. Games already detected as another supported engine also offer CrossOver when their content includes a Windows executable and a registered CrossOver application is available. Existing engine backends retain their defaults. After recognized formats have been checked, an unknown game uses the Windows module when the selected file is a Windows `.exe`, or the selected directory contains exactly one valid Windows executable at its top level. Its default runtime is Sikarugir; CrossOver can be selected when available. This fallback does not search subdirectories. A folder with multiple executables requires selecting the game's `.exe` directly. Native macOS app imports and Linux-only exports do not offer this backend. An unrelated neighboring Windows executable does not change their native format.

MacLauncher verifies executable headers rather than relying on the filename alone. x86 and x64 Windows executables are supported; DOS programs, DLLs, Windows ARM64 executables and installers requiring additional installation are outside this backend's playback support. Compatibility still depends on the game and selected CrossOver version. DRM, anti-cheat and missing Windows dependencies can prevent play.

Play automatically creates a private Windows bottle and private game files in the game's launcher data directory. Arbitrary Windows games can write settings or saves beside any asset, so the game folder is copied once using filesystem copy-on-write cloning when available. Other filesystems require storage for a separate copy. Relaunching checks source file metadata and reuses unchanged assets. Updated originals replace a private file only when its contents still match the previous original; saves, mod edits and private deletions remain intact. Newly added assets are copied, and files removed from the source remain in the private folder. Initial preparation records content hashes; later launches hash only changed candidates. Source folders and CrossOver applications remain unchanged. Forgetting a game removes its private files and bottles. Stop terminates Wine processes in that game's private bottle; cancelling initial preparation removes its incomplete environment so Play can retry.

Different registered applications and Windows environment types use separate bottles. Saves stored beside game files share the same private game folder; saves stored in a bottle's Windows profile remain with that bottle. Windows profile folder aliases into macOS Documents and Desktop are replaced with private directories. CrossOver does not supply a universal save editor or save-location format; engine save tools are unavailable while this backend is selected.

## Runtime Settings

Default settings and per-game overrides include:

- Graphics: Automatic, D3DMetal, DXMT, DXVK or WineD3D. Automatic preserves CrossOver's selection. Availability depends on the application, Mac and macOS version.
- Game temporal integration: exposes MetalFX Temporal through a 64-bit game’s DLSS integration. Requires Apple Silicon, matching NVAPI/NGX libraries, and DXMT on macOS 14 or later or D3DMetal on macOS 26 or later. Selecting a shared Temporal upscaling method also enables this integration at launch. DLSS must be enabled in the game. Automatic graphics selection remains controlled by CrossOver; other renderers do not supply these temporal inputs. This option does not enable DLSS frame generation or ray reconstruction.

- Synchronization: Automatic, MSync, ESync for older versions, or Off. Newer CrossOver releases may no longer support ESync.
- Language locale: an optional locale identifier such as `ja_JP.UTF-8`.
- Windows environment: Windows 10, Windows 11, Windows 7 or Windows XP, using a 64-bit bottle when included by the selected application.
- Windows executable: an optional relative path when automatic selection chooses the wrong executable.
- Wine DLL overrides, environment variables and game arguments. These apply to the game process; application and bottle paths remain managed automatically.
- BepInEx winhttp override: opt in to `winhttp=n,b` for a game that already contains BepInEx's proxy DLL. No mod, DLL or font download occurs. Explicit Wine DLL overrides take precedence, including grouped entries such as `winhttp,wininet=b`.

Enabled temporal rows in Advanced prepare the same game integration and
dependencies as Simple temporal settings. Disabled rows add no temporal demand.

FSR2/3 temporal replacement additionally requires a supported Streamline
interposer and a DXMT camera adapter matching the selected renderer's native
library and Windows thunk. CrossOver uses this adapter only with DXMT selected
explicitly. Compatible installed Wine support libraries are reused. Otherwise,
Play downloads the matching Template support package after consent; only its
DXMT libraries are retained, with no additional Wine engine. These libraries
are managed under Runtimes → CrossOver → Graphics bridge. Its version and default
are independent of the selected CrossOver application; a per-game Graphics bridge
setting can override that default. Preparation
uses private game and loader copies, preserving the imported files and supplied
CrossOver application. Camera values are associated with the game's exact frame
and viewport; unsupported projections retain the game's original scaler.
The private renderer selection disables CrossOver's automatic DLL redirection
for that launch and selects the matching DXMT libraries directly.

Optional per-game ReShade effects keep the selected CrossOver application, graphics backend and Windows environment. Turning effects on or off preserves saves and leaves the original CrossOver application unchanged. Effect compatibility depends on the game's rendering path.

Shared graphics controls use private copies of CrossOver's small Wine loaders,
prepared automatically with permission to load the graphics adapter. The copies
preserve the supplied loaders' other entitlements and are reused between launches.
CrossOver's application, license files and installed libraries remain in place;
the game's existing Windows bottle and saves are retained.

If the optional graphics loader cannot be prepared, the game uses the selected
vendor renderer and existing Windows bottle; shared graphics effects are omitted
for that launch. Saved graphics selections are preserved. An unavailable camera
adapter can be omitted while independent shared effects use an available loader.
Camera DLLs are prepared in a separate launch folder that references only the
game's private files. Executables and affected files use copy-on-write clones;
preparation failure leaves the ordinary game folder available. Saves,
configuration and mod changes are preserved in the private game folder after
Wine finishes, including files replaced or moved during play. Conflicting files
are retained separately. A filesystem without the required cloning support
uses the selected backend without the camera adapter.

Graphics provider architecture follows the native Wine process that runs the
game. When CrossOver uses a separate Unix loader, its available architectures
determine provider compatibility rather than the Windows executable or the
launcher. An Intel Wine process requires Intel-compatible graphics providers,
including on Apple Silicon through Rosetta.

Launch settings are checked before private game files or a new Windows environment are created. Changing the selected application or Windows environment preserves the previous bottle, and selecting it again reuses that bottle.

Graphics and synchronization behavior follow the [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index). The BepInEx option follows its [Wine instructions](https://docs.bepinex.dev/articles/advanced/proton_wine.html). A licensed CrossOver application and its own prerequisites remain required. Intel-only Wine components use the launcher's existing Rosetta check and installation consent flow, even when the CrossOver app itself is universal.

## Backend contract

CrossOver is registered as a runtime provider. Module discovery composes its runtime metadata and settings into detected Windows games without changing their engine identity. Offline detection records both positive and negative Windows executable evidence. Runtime support uses those cached facts and local application state; engine-specific preparation and runtime-download hooks do not run for a selected provider.

Application registrations live under `runtimes/crossover/registrations.json`. Game files, bottles and per-game records live under `games/<gameId>/runtimes/crossover/`. No CrossOver binaries are bundled, copied into runtime storage or downloaded by MacLauncher. Wine's macOS window driver requires a graphical login session, so native playback runs from the MacLauncher application. An SSH shell alone cannot supply that session. [NotProton](https://github.com/NotProtonNot/NotProton) demonstrates a separate Steam integration; this backend uses CrossOver's own commands and does not modify Steam or CrossOver.
