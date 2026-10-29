# Runtime settings and inspector actions

This reference lists, for each game type, its playback backends, every runtime setting and every inspector action. Runtime settings appear in **Settings** as module defaults and in a game's **Runtime Settings** as per-game overrides; settings marked *per game* exist only in the inspector. Settings marked *(Advanced)* follow the others inside a collapsed **Advanced** group whenever a backend also has common settings. Provider backends, marked *(provider)*, are offered for game types whose input they accept; their settings are listed under their own game type. Runtime guides describe the behavior behind each setting and action.

| Game type | Default backend | Backends |
| --- | --- | --- |
| [32-bit Mac](#32-bit-mac) | 32-bit Mac | 32-bit Mac |
| [AI5WIN](#ai5win) | AI5-SDL2 | AI5-SDL2, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [AliceSoft](#alicesoft) | System 1–3 | System 1–3, System 3.5–3.9, System 4, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Android](#android) | MacLauncher Android | MacLauncher Android, Mac.apk, AIM |
| [BGI / Ethornell](#bgi--ethornell) | Program tools | Program tools, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [CatSystem2](#catsystem2) | Archive and script tools | Archive and script tools, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Construct](#construct) | Electron | Electron, NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [DOS](#dos) | DOSBox Staging | DOSBox Staging, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [FAVORITE / FVP](#favorite--fvp) | RFVP | RFVP, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Flash](#flash) | Adobe Flash Player | Adobe Flash Player, Ruffle |
| [FNA / XNA 4](#fna--xna-4) | FNA | FNA, Author's macOS app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [GameMaker](#gamemaker) | Butterscotch | OpenGMK, Butterscotch, Official GameMaker, Game's macOS app, Inspect only, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [GameMaker HTML5](#gamemaker-html5) | Electron | Electron, NW.js, Native app |
| [Godot](#godot) | Godot | Godot, Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [HashLink (Haxe bytecode)](#hashlink-haxe-bytecode) | HashLink (Intel Mac; Rosetta on Apple Silicon) | HashLink (Intel Mac; Rosetta on Apple Silicon), CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Haxe native build](#haxe-native-build) | Native build inspection | Native build inspection, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Infinity Engine (GemRB)](#infinity-engine-gemrb) | GemRB | GemRB, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [iOS / iPadOS](#ios--ipados) | PlayCover (Apple Silicon) | PlayCover (Apple Silicon) |
| [Java](#java) | Java | Java |
| [KiriKiri](#kirikiri) | KiriKiri SDL2 | KiriKiri SDL2, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [LÖVE](#löve) | LÖVE | LÖVE, Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [macOS Game](#macos-game) | Native macOS | Native macOS, 32-bit Mac *(provider)* |
| [MAGES.](#mages) | Impacto Windows HD | Impacto Windows HD, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Minori](#minori) | ReMinori | ReMinori, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [MUGEN / Ikemen GO](#mugen--ikemen-go) | Ikemen GO (Apple Silicon) | Ikemen GO (Apple Silicon), CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Nintendo Switch](#nintendo-switch) | Switch (nxnative) | Switch (nxnative), Inspection |
| [Nitroplus](#nitroplus) | Nitroplus | Nitroplus, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [NScripter](#nscripter) | ONScripter-Yuri | ONScripter-Yuri, ONScripter-EN, ONScripter-Yuri Web, External runtime, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [PlayStation 5](#playstation-5) | PS5 (AnyPS5) | PS5 (AnyPS5), Inspection, Prosper *(provider)* |
| [Prosper](#prosper) | Prosper | Prosper |
| [Ren'Py](#renpy) | Ren'Py SDK | Ren'Py Patch, Ren'Py SDK, Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [RPG Maker 2000/2003](#rpg-maker-20002003) | EasyRPG Player | EasyRPG Player, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [RPG Maker MV](#rpg-maker-mv) | Electron | Electron, NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [RPG Maker MZ](#rpg-maker-mz) | Electron | Electron, NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [RPG Maker XP/VX/VX Ace](#rpg-maker-xpvxvx-ace) | MKXP-Z | MKXP-Z, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [ScummVM](#scummvm) | ScummVM | ScummVM, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Siglus / RealLive](#siglus--reallive) | Siglus | Siglus, RealLive (RLVM), CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Tyrano](#tyrano) | Electron | Electron, NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Unity](#unity) | Unity Mono player | Unity Mono player, Author’s macOS app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Video](#video) | mpv player | mpv player |
| [VNDS](#vnds) | VNDS-LOVE | VNDS-LOVE, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Web](#web) | Electron | Electron, NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |
| [Windows Game](#windows-game) | Sikarugir (Wine) | Sikarugir (Wine), CrossOver |
| [WOLF RPG Editor](#wolf-rpg-editor) | Browser Woditor | Browser Woditor, CrossOver *(provider)*, Sikarugir (Wine) *(provider)* |

## 32-bit Mac

Module `mac32`.

| Backend | Description and requirements |
| --- | --- |
| 32-bit Mac (default) | 32-bit Intel macOS applications · macOS 26 or later · Rosetta on Apple Silicon |

Runtimes tabs: 32-bit Mac (managed).

### 32-bit Mac settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Application arguments | List |  | One argument per line. |
| Additional library directory | Text |  | An optional folder containing compatible 32-bit Mac libraries. |
| Game compatibility patches | On/Off | Off | Allow mac32 to apply its compatibility fixes in game memory. Fixes apply only to matching game-library versions; original files remain unchanged. |

## AI5WIN

Module `ai5`.

Backends: AI5-SDL2 (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: AI5WIN (managed).

### AI5-SDL2 settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Game profile | Automatic; YU-NO (elf Classics); YU-NO English; Doukyuusei Windows; Doukyuusei 2 Windows CD; Kakyuusei 1998 CD; Isaku Renewal; Shuusaku; Ai Shimai | Automatic |  |
| Text capture | Off; Console; Clipboard | Off |  |
| Custom font | Text |  | Optional. Suitable runtime fonts are installed automatically. |

Inspector details: Game profile, Original file version, Version source, Script archive format.

| Action group | Actions |
| --- | --- |
| Advanced | Inspect data |

## AliceSoft

Module `alicesoft`.

Backends: System 1–3 (default), System 3.5–3.9, System 4, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: AliceSoft → Alice tools (managed); AliceSoft → System 1–3 (managed); AliceSoft → System 3.5–3.9 (managed); AliceSoft → System 4 (managed); AliceSoft → System1–3 source (managed); AliceSoft → System3.x source (managed).

### System 1–3 settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Version to register | Current selection; installed or detected options | Current selection |  |
| Font override | Text |  | Optional local TTF/OTF. Bundled runtimes provide a default font automatically. |
| Game ID override | Text |  | Use the upstream game ID for translated or modified games. |
| Text capture | Off; Console; Clipboard | Off |  |
| Start fullscreen | On/Off | Off |  |

### System 3.5–3.9 settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Version to register | Current selection; installed or detected options | Current selection |  |
| Font override | Text |  | Optional local TTF/OTF for both text styles. Bundled runtimes provide gothic and mincho fonts automatically. |
| Game ID override | Text |  | Use the upstream game ID for translated or modified games. |
| Text capture | Off; Console; Clipboard | Off |  |
| Start fullscreen | On/Off | Off |  |

### System 4 settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Version to register | Current selection; installed or detected options | Current selection |  |
| Font override | Text |  | Optional local TTF/OTF for both text styles. Bundled runtimes provide gothic and mincho fonts automatically. |
| Text capture | Off; Console | Off |  |

Inspector details: Detected engine version, Engine family, Version confidence, Version evidence, Scenario format, AIN format version, Detected game ID, Compatibility.

| Action group | Actions |
| --- | --- |
| Live | Live variables |
| Source | Decompile; Reveal export |

## Android

Module `android`.

| Backend | Description and requirements |
| --- | --- |
| MacLauncher Android (default) | Android 16 · ARM64 / ARM32 · optional microG · Apple Silicon · macOS 13.0 or later |
| Mac.apk | ARM64 Android runtime with optional Google sign-in. · Apple Silicon · macOS 26.4 or later |
| AIM | Original Android 16 with a Pixel Tablet display: 2560 × 1600 at 320 dpi. · Apple Silicon · macOS 26.0 or later · 1.95 GB system image |

Runtimes tabs: Tools → Apktool (managed); Tools → JADX (managed); MacLauncher Android → JVM (managed); MacLauncher Android → ART (managed); Mac.apk (managed); AIM (managed).

### MacLauncher Android settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Execution | JVM; ART | JVM | Android execution engine. Changes apply on the next launch. |
| Initial width | Number 64–8192 | `1280` |  |
| Initial height | Number 64–8192 | `800` |  |
| OpenGL ES backend | Metal; Vulkan; installed or detected options | Metal | Select ANGLE's graphics backend for the next launch. Vulkan uses the selected Vulkan implementation. |
| Vulkan implementation | Text | `auto` | Select an installed Vulkan implementation for Vulkan apps and ANGLE's Vulkan backend. Graphics → MoltenVK and KosmicKrisp in Runtimes manage downloads. |
| Manual tilt *(per game)* | Off; Keyboard; Controller | Off | Provide virtual motion sensors. Keyboard uses Q/E to tilt left/right and R to recenter; Option + arrow keys and Option + 0 are also available. Controller uses the right stick. No physical motion or location is collected. |
| Keyboard touch joystick *(per game)* | Off; WASD; Arrow keys; WASD and arrow keys | WASD | WASD controls a virtual touch joystick by default while the mouse operates a second touch, such as a boost button. Joystick mapping pauses during text editing; Command shortcuts retain normal keyboard input. Applies on the next launch. |
| Joystick center X (%) *(per game)* | Number 0–100 | `18` | Horizontal center, measured from the left of the Android display. |
| Joystick center Y (%) *(per game)* | Number 0–100 | `75` | Vertical center, measured from the top of the Android display. |
| Joystick radius (%) *(per game)* | Number 0.01–50 | `12` | Drag distance as a percentage of the shorter Android display dimension. Diagonal movement keeps the same distance. |
| Allow ads | On/Off | Off | Allow connections to known advertising hosts, including rewarded ads. Off by default. Applies on the next launch; game settings can override the Android default. External web links always require confirmation. |
| Use microG *(per game)* | On/Off | Off | Enable installed Google services for this game without signing in. Restart to apply. |
| microG account *(per game)* | Text |  | Use microG anonymously or with a shared account from Settings → Android. Restart to apply. |
| Audio input *(per game)* | Text |  |  |
| OBS camera *(per game)* | Text |  |  |
| Network access | On/Off | On | Allow Internet and local-network connections. Restart to apply. |

### Mac.apk settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Initial width | Number 64–8192 | `1280` |  |
| Initial height | Number 64–8192 | `800` |  |
| Graphics backend | Automatic; Metal; Vulkan (MoltenVK) | Automatic |  |
| Google integration *(per game)* | On/Off | Off | Enable Google account access for this application. Restart to apply. |
| Google account *(per game)* | Text |  | Use Google services anonymously or with an account from Settings → Android. Restart to apply. |
| Network access | On/Off | On | Allow Internet and local-network connections. Restart to apply. |

### AIM settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Network access | On/Off | On | Network access is disabled for this runtime. |

| Action group | Actions |
| --- | --- |
| APK tools | Decompile APK…; Decode APK; Reveal decompiled APK; Inspect Android package |
| Files | Import files… |
| Google Play | Add to Google Play library |

## BGI / Ethornell

Module `bgi`.

Backends: Program tools (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Tools → msg-tool (managed).

Inspector details: Archive format, Original executable version, Declared compatibility, Native support.

| Action group | Actions |
| --- | --- |
| Actions | Export text; Inspect programs; Export programs |

## CatSystem2

Module `catsystem2`.

Backends: Archive and script tools (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Inspector details: Archive format, Native requirements, Support.

| Action group | Actions |
| --- | --- |
| Scripts | Export scripts |
| Advanced | Inspect archives; Inspect scripts; Export scene archive |

## Construct

Module `construct`.

Backends: Electron (default), NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js (Patched) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |
| Enable case-insensitive assets | On/Off | Off |  |
| Enable user scripts | On/Off | Off |  |

Inspector details: Construct runtime.

| Action group | Actions |
| --- | --- |
| Bundle | Refresh status; Extract bundle; Reveal extracted files; Remove extracted files |

## DOS

Module `dosbox`.

Backends: DOSBox Staging (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: DOSBox (managed).

### DOSBox Staging settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Fullscreen | On/Off | Off |  |
| Machine | SVGA; EGA; CGA; Tandy; PCjr; Hercules | SVGA |  |
| CPU cycles | Text | `auto` | auto, max or a positive number. |

Inspector details: Format, Bits.

| Action group | Actions |
| --- | --- |
| Actions | Inspect program; Decompile; Show export |

## FAVORITE / FVP

Module `fvp`.

Backends: RFVP (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: RFVP (managed); Tools → msg-tool (managed).

### RFVP settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Text encoding | Japanese (Shift-JIS); Chinese (GBK); Unicode (UTF-8) | Japanese (Shift-JIS) | Japanese game data uses Shift-JIS. Select the encoding supplied by a translation patch. |
| High-resolution text | On/Off | On | Render text at the display scale. |

Inspector details: Script, Game resolution, Resource archives.

| Action group | Actions |
| --- | --- |
| Source | Export text |
| Assets | List assets; Extract assets; Show assets; Remove extracted assets |
| Advanced | Inspect game data |

## Flash

Module `flash`.

Backends: Adobe Flash Player (default), Ruffle.

Runtimes tabs: Flash → Flash Player (managed); Flash → Ruffle (managed); Flash → JPEXS FFDec (managed).

| Action group | Actions |
| --- | --- |
| Flash tools | Export ActionScript; Export scripts and assets; Reveal export |

## FNA / XNA 4

Module `fna`.

Backends: FNA (default), Author's macOS app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: FNA (managed).

### FNA settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Use selected FNA framework | On/Off | On | Automatic framework compatibility. Disable for a compatible game framework. |
| Convert portable x64 assemblies | On/Off | On | Converts compatible portable x64 assemblies automatically. |
| Allow software OpenGL | On/Off | Off | Software OpenGL for Macs without graphics acceleration; rendering can be slower. |
| Graphics driver | Automatic; OpenGL | Automatic |  |
| Game arguments | List |  |  |

Inspector details: Game assembly version, Game framework version, Framework, .NET target, CLR metadata, Compatibility, Managed entry point, Windows APIs, Native imports.

| Action group | Actions |
| --- | --- |
| Source | Decompile; Reveal source |
| Advanced | Inspect managed assemblies |

## GameMaker

Module `gamemaker`.

Backends: OpenGMK, Butterscotch (default), Official GameMaker, Game's macOS app, Inspect only, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: GameMaker → Official (managed); GameMaker → Butterscotch (managed); GameMaker → Classic (OpenGMK) (managed); GameMaker → GM8Decompiler (managed); GameMaker → UMT (managed); GameMaker → Graphics helper (managed).

### Official GameMaker settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Graphics fallback | Automatic; Enabled; Disabled | Automatic | Uses software rendering when hardware OpenGL is unavailable. |
| Graphics helper | Use Runtimes selection; v5; v4; v3; v2; v1 |  | Uses the managed graphics helper selection. Existing local profiles remain available. |

Inspector details: GameMaker family, Execution format, Header version (GMS2 may be stale), Detected engine format version, Version confidence, WAD version, Compatibility evidence, Extension declarations, Classic external definitions, Windows extensions requiring native support, Runtime compatibility, Last runtime build, Registered official Studio build, Official compatibility, Latest export.

| Action group | Actions |
| --- | --- |
| Tools | Decompile; Export textures and sprites; Reveal latest export |
| Advanced | Export inspection report; Export raw Studio chunks |

## GameMaker HTML5

Module `gamemaker-html5`.

Backends: Electron (default), NW.js, Native app.

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

Inspector details: Asset compiler version, Version evidence, Game app version, Detection reference.

## Godot

Module `godot`.

Backends: Godot (default), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Godot (managed).

### Godot settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Prefer extracted project | On/Off | Off | Launch recovered project files when available. |

| Action group | Actions |
| --- | --- |
| Project | Recover project; Recover project again…; Reveal; Refresh status; Detect version; List packed files; Remove Extracted |
| Resources | Decompile GDScript…; Convert resources to text…; Convert resources to binary… |

## HashLink (Haxe bytecode)

Module `hashlink`.

Backends: HashLink (Intel Mac; Rosetta on Apple Silicon) (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: HashLink (managed); HashLink → hlbc (managed).

### HashLink (Intel Mac; Rosetta on Apple Silicon) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Additional macOS native modules directory | Text |  | Modules must match the Intel HashLink runtime; Windows .hdll files are incompatible. |
| Application arguments | List |  |  |

Inspector details: Bytecode version, Bytecode, Version source, Confidence, SDL primitive ABI.

| Action group | Actions |
| --- | --- |
| Advanced | Export bytecode; Inspect bytecode |

## Haxe native build

Module `haxe`.

Backends: Native build inspection (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Inspector details: Target, CPU, Support.

## Infinity Engine (GemRB)

Module `gemrb`.

Backends: GemRB (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: GemRB (managed); GemRB → Near Infinity (managed).

### GemRB settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Local runtime version | Automatic; installed or detected options | Automatic |  |
| Game type | Auto-detect; Baldur's Gate; Baldur's Gate II; Icewind Dale; Icewind Dale II; Planescape: Torment; GemRB demo | Auto-detect |  |
| Custom game profile (optional) | Text |  | For standalone games: the author's profile name and GUI script/data paths. |
| Width | Number | `800` |  |
| Height | Number | `600` |  |
| Fullscreen | On/Off | Off |  |
| Enable GemRB cheat keys | On/Off | Off |  |
| GemRB data directory (optional) | Text |  |  |
| Folder containing GUIScripts (optional) | Text |  |  |
| Plugins directory (optional) | Text |  |  |

Inspector details: Game type, GAME format version, Indexed resources.

| Action group | Actions |
| --- | --- |
| Game tools | Open Near Infinity |
| Advanced | Inspect game version; Prepare configuration |

## iOS / iPadOS

Module `ios`.

Backends: PlayCover (Apple Silicon) (default).

Runtimes tabs: PlayCover (managed).

### PlayCover (Apple Silicon) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Keyboard and mouse mapping | On/Off | On | Use PlayTools touch controls. Press Cmd-K in the game to open or close its keymap editor. Keymaps are saved automatically for this game. Changes to this setting apply on the next launch. |
| Mouse sensitivity | Number | `50` | 1–1000; default 50. |
| Pause keymapping during text input | On/Off | On |  |
| Scroll wheel gestures | On/Off | On |  |
| Window mode | Application default; Fixed size; Resizable | Resizable | Resizable lets PlayTools follow the Mac window size. Fixed uses the selected dimensions. Application default keeps the app's display configuration. |
| Window width | Number | `1920` | 320–7680; default 1920. Changes apply on the next launch. |
| Window height | Number | `1080` | 240–4320; default 1080. |
| iOS device model | iPad Pro 12.9-inch (M1); iPad Pro 12.9-inch (3rd generation); iPad Pro 12.9-inch (M2); iPhone 13 Pro Max | iPad Pro 12.9-inch (M1) | Device identity reported by PlayTools. Application support varies. |
| Game arguments | List |  |  |

Inspector details: Application identifier, Version, Architecture, Compatibility.

| Action group | Actions |
| --- | --- |
| Tools | Inspect IPA; Extract IPA contents; Reveal extracted contents |

## Java

Module `java`.

Backends: Java (default).

Runtimes tabs: Java (Temurin) (managed).

### Java settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| JVM arguments | List |  | One argument per line. |
| Application arguments | List |  | One argument per line. |
| Working directory | Jar directory; Game directory | Jar directory |  |

| Action group | Actions |
| --- | --- |
| Source | Decompile Java; Reveal; Refresh status; Remove decompiled files |

## KiriKiri

Module `kirikiri`.

Backends: KiriKiri SDL2 (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Tools → msg-tool (managed); KiriKiri (managed).

### KiriKiri SDL2 settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Version | Runtime default; installed or detected options | Runtime default |  |
| Extra runtime options | List |  | One option per line. |

Inspector details: Detected engine/script version, Engine family, Version confidence, Version evidence, Compatibility, Source, KAG save routing.

| Action group | Actions |
| --- | --- |
| Script tools | Export scripts; Reveal scripts |

## LÖVE

Module `love`.

Backends: LÖVE (default), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: LÖVE → LJD (managed); LÖVE → unluac (managed); LÖVE (managed).

Inspector details: LÖVE version, AppImage extracted, AppImage extracted at, AppImage cache.

| Action group | Actions |
| --- | --- |
| Source | Export source; Reveal source |

## macOS Game

Module `generic-app`.

Backends: Native macOS (default), 32-bit Mac *(provider)*.

Inspector details: App version, Bundle ID, Executable.

| Action group | Actions |
| --- | --- |
| Script | Make executable |

## MAGES.

Module `mages`.

Backends: Impacto Windows HD (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: MAGES. → sc3tools (managed); MAGES. (managed).

Inspector details: Data edition, Archive format, Script format, Original executable version, Original product version, Version source, Native support, Native runtime, Native runtime macOS minimum.

| Action group | Actions |
| --- | --- |
| Actions | Export text; Inspect archives; Inspect scripts; Export compiled scripts |

## Minori

Module `minori`.

Backends: ReMinori (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Minori (managed).

Inspector details: Data format, Original executable version.

| Action group | Actions |
| --- | --- |
| Scripts | Extract scripts; Reveal scripts; Remove scripts |
| Advanced | Verify archives |

## MUGEN / Ikemen GO

Module `ikemen`.

Backends: Ikemen GO (Apple Silicon) (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Ikemen GO (managed); Ikemen GO → SFF Tools (managed).

### Ikemen GO (Apple Silicon) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Game arguments | List |  |  |

Inspector details: Source format, Motif, Declared content requirement, Version source, Original runner revision, Runner build date, Modified runner build.

| Action group | Actions |
| --- | --- |
| Sprites | Export sprites |
| Advanced | Inspect game version |

## Nintendo Switch

Module `nxnative`.

Backends: Switch (nxnative) (default), Inspection.

Runtimes tabs: Switch (nxnative) (managed); Switch (nxnative) → Native tools (managed).

### Switch (nxnative) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| prod.keys | Path (with picker) |  | Keys for encrypted Switch game data. The file stays in its current location. |
| Fixed keyboard mapping | Information |  | nxnative uses fixed physical key positions; keyboard remapping is not supported. Key names below follow the US keyboard layout. Rows: L + R prompt: Hold Q + E; Left stick: W A S D; D-pad: Arrow keys; A / B / X / Y: J / K / U / I; L / R: Q / E; ZL / ZR: Z / C; Right stick: No keyboard binding; L3 / R3: F / G; + / −: Return / Tab; Shake: Space; Touch: Left click / drag; Fullscreen: Control + Command + F. |
| Fixed controller mapping | Information |  | Connected controllers with a macOS extended gamepad profile are detected automatically; controller remapping is not supported. Face buttons map by position, regardless of their printed labels. Rows: A / B / X / Y: Right / Bottom / Top / Left; Left / Right stick: Left / Right stick; D-pad: D-pad; L / R: Left / Right shoulder; ZL / ZR: Left / Right trigger; L3 / R3: Left / Right stick click; + / −: Menu / Options. |

Inspector details: Title ID, Format, Build ID.

| Action group | Actions |
| --- | --- |
| Actions | Inspect program; Decompile; Choose prod.keys…; Show export |

## Nitroplus

Module `nitroplus`.

Backends: Nitroplus (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Nitroplus (managed).

Inspector details: Script format, Authored script version, Script version source, Game product version, Original file version, Original version source, Native compatibility.

| Action group | Actions |
| --- | --- |
| Archives and scripts | Inspect archives; Extract scripts; Check script compiler; Log |

## NScripter

Module `nscripter`.

Backends: ONScripter-Yuri (default), ONScripter-EN, ONScripter-Yuri Web, External runtime, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: NScripter → ONScripter-Yuri (managed); NScripter → ONScripter-EN (managed).

### ONScripter-Yuri settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Script encoding | Shift-JIS (Japanese); GBK (Chinese); UTF-8; Runtime default | Shift-JIS (Japanese) | Original Japanese scripts usually use Shift-JIS. Choose GBK for Chinese releases or UTF-8 for converted scripts. A .utf script alias always uses UTF-8. |

### ONScripter-EN settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Text mode | Automatic; Japanese; English | Automatic |  |
| Fullscreen | On/Off | Off |  |
| Variable editor (Z) | On/Off | Off |  |

### ONScripter-Yuri Web settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Script encoding | Shift-JIS (Japanese); GBK (Chinese); UTF-8; Runtime default | Shift-JIS (Japanese) | Original Japanese scripts usually use Shift-JIS. Choose GBK for Chinese releases or UTF-8 for converted scripts. A .utf script alias always uses UTF-8. Web runs through NW.js; Play prepares missing runtime downloads after consent. |

| Action group | Actions |
| --- | --- |
| Source | Export script; Reveal source |

## PlayStation 5

Module `anyps5`.

Backends: PS5 (AnyPS5) (default), Inspection, Prosper *(provider)*.

Runtimes tabs: PS5 (AnyPS5) (managed).

### PS5 (AnyPS5) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Vulkan | Automatic; installed or detected options | Automatic |  |
| Mouse input | Automatic; Controller bindings; Native mouse | Automatic | Controller bindings use the mouse buttons and wheel as mapped below. Native mouse sends them directly to the game. F7 toggles capture. Applies on the next launch. |
| Cross (X) | Text | `K, Space, Return` | Comma-separated key names or Mouse Left, Mouse Right, Mouse Middle, Mouse X1/X2 and Wheel Up/Down. Blank restores the default. Applies on the next launch. |
| Circle (○) | Text | `L, C` |  |
| Triangle (△) | Text | `I` |  |
| Square (□) | Text | `J, Mouse Right` |  |
| R2 | Text | `U, Mouse Left` |  |
| L2 | Text | `R, Mouse X1` |  |
| L1 | Text | `Q` |  |
| R1 | Text | `E, Left Alt, Right Alt` |  |
| L3 | Text | `Left Shift, Right Shift` |  |
| R3 | Text | `Left Ctrl, Right Ctrl` |  |
| Options | Text | `Escape` |  |
| D-pad ↑ | Text | `Up, Wheel Up` |  |
| D-pad ↓ | Text | `Down, Wheel Down` |  |
| D-pad ← | Text | `Left` |  |
| D-pad → | Text | `Right` |  |
| Left stick ↑ | Text | `W` |  |
| Left stick ↓ | Text | `S` |  |
| Left stick ← | Text | `A` |  |
| Left stick → | Text | `D` |  |
| Right stick ↑ | Text | `T` |  |
| Right stick ↓ | Text | `G` |  |
| Right stick ← | Text | `F` |  |
| Right stick → | Text | `H` |  |
| Touchpad click | Text | `V` | Requires touchpad key support in the selected runtime. |
| Touch left | Text | `Backspace` |  |
| Touch right | Text | `Tab` |  |
| Mouse capture | Text | `F7, Mouse Middle` |  |
| Shake | Text | `X` |  |
| Stick modifier | Text |  |  |
| Fullscreen | Text | `F11` |  |
| Performance overlay | Text | `F10` |  |
| Screenshot | Text | `F12` |  |

Inspector details: Title ID, Version, Format, Status.

| Action group | Actions |
| --- | --- |
| Actions | Inspect package; Inspect program; Decompile; Show export |

## Prosper

Module `prosper`.

| Backend | Description and requirements |
| --- | --- |
| Prosper (default) | Local macOS build · Rosetta on Apple Silicon · Vulkan 1.4 |

Runtimes tabs: Prosper (managed).

### Prosper settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Vulkan | Automatic; installed or detected options | Automatic |  |
| Frame rate | On/Off | Off |  |

## Ren'Py

Module `renpy`.

Backends: Ren'Py Patch, Ren'Py SDK (default), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Ren'Py (managed).

Inspector details: Runtime version.

| Action group | Actions |
| --- | --- |
| Save metadata | Inspect save metadata; Reveal metadata report |
| Ren'Py Patching | Refresh Ren'Py patch status; Patch; Remove Ren'Py patch |
| Builds | Reload; Reveal; Build app bundle; Remove app bundle |
| Extract | Reload; Reveal; Extract; Remove Extracted |
| Libraries | Live2D status; Install Live2D library; Remove Live2D library |
| Other | Enable Ren'Py console (Shift+O); Remove Ren'Py console patch; Refresh Ren'Py cheats; Patch Universal Ren'Py Walkthrough System; Remove Universal Ren'Py Walkthrough System; Add Universal Ren'Py Mod; Remove Universal Ren'Py Mod |

## RPG Maker 2000/2003

Module `easyrpg`.

Backends: EasyRPG Player (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: EasyRPG Player (managed).

### EasyRPG Player settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Fullscreen | On/Off | Off |  |
| Scaling | Integer; Nearest; Bilinear | Integer |  |
| Engine mode | Automatic; RPG Maker 2000 (1.00–1.10); RPG Maker 2000 (1.50–1.51); RPG Maker 2000 English (1.61); RPG Maker 2003 (1.00–1.04); RPG Maker 2003 (1.05–1.09a); RPG Maker 2003 English (1.12) | Automatic | Automatic detection is recommended. Select an original RPG Maker edition for games with incorrect version detection. |
| Text encoding | Text |  | Leave empty for automatic detection. Examples: 932 for Japanese, 1252 for Western European text. |
| Translation language | Text |  | Optional language folder supplied with the game. |
| RTP folders | List |  | Optional absolute paths to RPG Maker 2000/2003 Runtime Package assets. |
| MIDI soundfont | Text |  | Optional absolute path to an SF2 soundfont. Without a soundfont, the built-in FM MIDI driver remains available. |
| Disable audio | On/Off | Off |  |
| Show frame rate | On/Off | Off |  |
| Game arguments | List |  | Additional EasyRPG options, one argument per line. |

Inspector details: Game format, Maps, Declared text encoding, DynRPG plug-ins.

| Action group | Actions |
| --- | --- |
| Project data | Export project JSON; Export game text; Reveal export |
| Advanced | Inspect project |

## RPG Maker MV

Module `mv`.

Backends: Electron (default), NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: NW.js (managed).

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js (Patched) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |
| Enable case-insensitive assets | On/Off | Off |  |
| Enable user scripts | On/Off | Off |  |
| Enable decrypted assets | On/Off | Off |  |
| Enable remap + fixes | On/Off | Off |  |
| Enable vars inspector (ES13) | On/Off | Off |  |

| Action group | Actions |
| --- | --- |
| Plugins | Reload; Install text hooker; Uninstall text hooker; Install 500 save slots; Uninstall 500 save slots |
| Extract | Reload; Reveal; Extract; Remove Extracted |

## RPG Maker MZ

Module `mz`.

Backends: Electron (default), NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js (Patched) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |
| Enable case-insensitive assets | On/Off | Off |  |
| Enable user scripts | On/Off | Off |  |
| Enable decrypted assets | On/Off | Off |  |
| Enable remap + fixes | On/Off | Off |  |
| Enable vars inspector (ES13) | On/Off | Off |  |

| Action group | Actions |
| --- | --- |
| Plugins | Reload; Install text hooker; Uninstall text hooker; Install 500 save slots; Uninstall 500 save slots |
| Extract | Reload; Reveal; Extract; Remove Extracted |

## RPG Maker XP/VX/VX Ace

Module `rgss`.

Backends: MKXP-Z (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: MKXP-Z (managed).

### MKXP-Z settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| RTP source | Auto (detected RTP); Manual path | Auto (detected RTP) |  |
| RTP path | Text |  |  |
| RGSS version | Detected (launcher); Auto (MKXP-Z); RGSS1; RGSS2; RGSS3 | Detected (launcher) | Detected uses launcher metadata; Auto lets MKXP-Z guess. |
| Start fullscreen | On/Off | Off |  |
| Preserve aspect ratio | On/Off | On |  |
| Resizable window | On/Off | On |  |
| Display FPS | On/Off | Off |  |
| Enable VSync | On/Off | Off |  |
| Default window width | Number | `0` |  |
| Default window height | Number | `0` |  |
| Enable F12 reset | On/Off | On |  |
| Enable F1 settings | On/Off | On |  |
| Extra RTP paths *(Advanced)* | List |  | One path per line (commas also work). Appended after the primary RTP. |
| MIDI soundfont path *(Advanced)* | Text |  |  |
| Kawariki preload path *(Advanced)* | Text |  |  |
| Extra preload scripts *(Advanced)* | List |  | One script path per line (commas also work). |
| Postload scripts *(Advanced)* | List |  | One script path per line (commas also work). |
| Executable name override *(Advanced)* | Text |  |  |
| Custom script path *(Advanced)* | Text |  |  |
| Print FPS to console *(Advanced)* | On/Off | Off |  |
| Window title override *(Advanced)* | Text |  |  |
| Fixed framerate (0 = auto) *(Advanced)* | Number | `0` |  |
| Enable frame skip *(Advanced)* | On/Off | Off |  |
| Sync to refresh rate *(Advanced)* | On/Off | Off |  |
| Smooth scaling (upscale) *(Advanced)* | Nearest neighbor; Bilinear; Bicubic; Lanczos3; xBRZ | Nearest neighbor |  |
| Smooth scaling (downscale) *(Advanced)* | Nearest neighbor; Bilinear; Bicubic; Lanczos3; xBRZ | Nearest neighbor |  |
| Bitmap smoothing (upscale) *(Advanced)* | Nearest neighbor; Bilinear; Bicubic; Lanczos3; xBRZ | Nearest neighbor |  |
| Bitmap smoothing (downscale) *(Advanced)* | Nearest neighbor; Bilinear; Bicubic; Lanczos3; xBRZ | Nearest neighbor |  |
| Enable scaling mipmaps *(Advanced)* | On/Off | Off |  |
| Bicubic sharpness *(Advanced)* | Number | `100` |  |
| xBRZ scaling factor *(Advanced)* | Number | `1` |  |
| Enable integer scaling *(Advanced)* | On/Off | Off |  |
| Integer scaling last mile *(Advanced)* | On/Off | On |  |
| Enable high-res assets *(Advanced)* | On/Off | Off |  |
| Texture scaling factor *(Advanced)* | Number | `1` |  |
| Framebuffer scaling factor *(Advanced)* | Number | `1` |  |
| Atlas scaling factor *(Advanced)* | Number | `1` |  |
| Renderer preference *(Advanced)* | Auto (MKXP-Z default); Prefer Metal; Prefer OpenGL | Auto (MKXP-Z default) | Auto uses MKXP-Z hardware defaults. |
| Blitting *(Advanced)* | Auto (MKXP-Z default); On; Off | Auto (MKXP-Z default) | Auto uses MKXP-Z platform defaults. |
| Enable sub-image fix *(Advanced)* | On/Off | Off |  |
| Max texture size *(Advanced)* | Number | `0` |  |
| Any Alt toggles fullscreen *(Advanced)* | On/Off | Off |  |
| Allow symlinks *(Advanced)* | On/Off | On |  |
| Enable path cache *(Advanced)* | On/Off | On |  |
| Use script names in errors *(Advanced)* | On/Off | On |  |
| Data path org *(Advanced)* | Text |  |  |
| Data path app *(Advanced)* | Text |  |  |
| Window icon path *(Advanced)* | Text |  | Linux only. |
| Solid fonts *(Advanced)* | List |  | One font family per line (commas also work). |
| Font substitutions *(Advanced)* | List |  | One mapping per line (commas also work). Use `From>To`. |
| Font scale *(Advanced)* | Number | `1` |  |
| Enable font kerning *(Advanced)* | On/Off | On |  |
| Font hinting *(Advanced)* | Normal; Light; Mono; None | None |  |
| Font height reporting *(Advanced)* | Nominal (RGSS); Rendered | Nominal (RGSS) |  |
| Crop outlined text edges *(Advanced)* | On/Off | On |  |
| Ruby load paths *(Advanced)* | List |  | One path per line (commas also work). |
| Enable MIDI chorus *(Advanced)* | On/Off | Off |  |
| Enable MIDI reverb *(Advanced)* | On/Off | Off |  |
| SE source count *(Advanced)* | Number | `6` |  |
| BGM track count *(Advanced)* | Number | `1` |  |
| Enable MJIT *(Advanced)* | On/Off | Off |  |
| MJIT verbose level *(Advanced)* | Number | `0` |  |
| MJIT max cache *(Advanced)* | Number | `100` |  |
| MJIT min calls *(Advanced)* | Number | `10000` |  |
| Enable YJIT *(Advanced)* | On/Off | Off |  |
| Patch archives *(Advanced)* | List |  | One path per line (commas also work). Loaded before game assets. |
| Dump atlas textures *(Advanced)* | On/Off | Off |  |

| Action group | Actions |
| --- | --- |
| Ruby scripts | Reload tools; Export Ruby scripts; Reveal scripts; Repack edited scripts |
| Saves and databases | Find portable saves; Inspect save or database |
| Assets | Reload; Reveal; Extract runtime assets; Remove runtime assets |
| Extract | Reload; Reveal; Extract; Remove Extracted |

## ScummVM

Module `scummvm`.

Backends: ScummVM (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: ScummVM → ScummVM player (managed); ScummVM → ScummVM Tools (managed).

### ScummVM settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Fullscreen | On/Off | Off |  |
| Aspect ratio correction | On/Off | On |  |
| Image filtering | On/Off | Off |  |
| Graphics mode | Automatic; OpenGL; Software; Software (2×); Software (3×) | Automatic |  |
| 3D renderer | Automatic; OpenGL; OpenGL shaders; Software | Automatic | Applies to games with 3D graphics. |
| Game language | Text | `auto` | Automatic, or a ScummVM language code such as en, de or fr. |
| Music volume | Number 0–255 | `192` |  |
| Speech volume | Number 0–255 | `192` |  |
| Effects volume | Number 0–255 | `192` |  |
| Game ID override | Text |  | Optional engine:game ID when a folder contains multiple editions. Empty uses automatic detection. |

Inspector details: Data format, Game ID, Game edition, Inspected with ScummVM.

| Action group | Actions |
| --- | --- |
| Game tools | Extract game archives; Reveal extracted files |
| Advanced | Identify game edition |

## Siglus / RealLive

Module `siglus`.

Backends: Siglus (default), RealLive (RLVM), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Siglus → Siglus SceneScript Utility (managed); RealLive (RLVM) → RLdev (managed); Siglus (managed); RealLive (RLVM) (managed); RealLive (RLVM) → MacLauncher adapter (managed).

### Siglus settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Text encoding | Automatic; Japanese; UTF-8; Windows-1252; Simplified Chinese; Traditional Chinese; Korean | Automatic | siglus_rs runs supported Siglus, RealLive and AVG32 formats. Automatic uses RealLive's encoding metadata; unsupported script revisions stop before launch. |
| Siglus strings | Automatic; XOR; Plain; Detect historical encoding | Automatic |  |

Inspector details: Format, Script compiler.

| Action group | Actions |
| --- | --- |
| Source | Decompile; Reveal source |
| Advanced | Inspect scripts |

## Tyrano

Module `tyrano`.

Backends: Electron (default), NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js (Patched) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |
| Enable case-insensitive assets | On/Off | Off |  |
| Enable user scripts | On/Off | Off |  |

Inspector details: Tyrano version.

| Action group | Actions |
| --- | --- |
| Extract | Reload; Reveal; Extract; Remove Extracted |

## Unity

Module `unity`.

Backends: Unity Mono player (default), Author’s macOS app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: Unity (managed); Unity → AssetRipper (managed); Unity → Cpp2IL (managed).

### Unity Mono player settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Renderer | Automatic; Metal; OpenGL | Automatic |  |
| Start in a window | On/Off | On |  |

Inspector details: Scripting, Compatibility, Graphics.

| Action group | Actions |
| --- | --- |
| Assets | Inspect assets; Close inspector; Export assets; Reveal assets |
| Source | Decompile; Reveal source |
| Advanced | Inspect |

## Video

Module `video`.

Backends: mpv player (default).

Runtimes tabs: mpv player → Player (managed); mpv player → Plugins (managed).

### mpv player settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| uosc controls | On/Off | On | Use uosc for the playback controls and timeline. Install it in Runtimes → mpv player → Plugins to enable the control. Playback uses the standard controls when uosc is missing. |
| Timeline previews | On/Off | On | Generate thumbnail previews while hovering over the timeline with thumbfast. Install it in Runtimes → mpv player → Plugins to enable the control. Requires uosc or another thumbfast-compatible interface. |
| Configuration folder | Path (with picker) |  | Optional mpv configuration folder containing mpv.conf, input.conf, scripts, script-opts, fonts and other mpv resources. The selected folder is read directly. |
| Additional configuration files | List |  | Absolute paths, one per line. Files load in order after the configuration folder. mpv include entries can reference further configuration and resources. |
| Additional scripts | List |  | Absolute paths to Lua or JavaScript scripts, or mpv script folders, one per line. The original files stay in place. |
| Input configuration | Path (with picker) |  | Optional input.conf file for custom keyboard and mouse bindings. Playback configuration changes apply on the next Play. |

Inspector details: Container.

| Action group | Actions |
| --- | --- |
| Video processing | Inspect media; Preview settings; Export video… |
| Other | Process with neural model… |

## VNDS

Module `vnds`.

Backends: VNDS-LOVE (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: VNDS → VNDS-LOVE (managed).

### VNDS-LOVE settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Fullscreen | On/Off | Off |  |

| Action group | Actions |
| --- | --- |
| Actions | Show scripts |

## Web

Module `web`.

Backends: Electron (default), NW.js, NW.js (Patched), Native app, CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

### Electron settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |

### NW.js (Patched) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Enable protections | On/Off | On |  |
| Enable case-insensitive assets | On/Off | Off |  |
| Enable user scripts | On/Off | Off |  |

## Windows Game

Module `crossover`.

Backends: Sikarugir (Wine) (default), CrossOver.

Runtimes tabs: CrossOver (managed); Sikarugir (managed); CrossOver → DXMT support (managed); Sikarugir → DXMT support (managed).

### Sikarugir (Wine) settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Graphics | Automatic; D3DMetal; DXMT; DXVK; WineD3D | Automatic | Availability depends on the selected Wine version, Mac and macOS version. |
| Game temporal integration | On/Off | Off | Expose the game's DLSS option through MetalFX Temporal. A shared temporal upscaler also enables this integration automatically. Requires Apple Silicon and DXMT on macOS 14 or later, or D3DMetal on macOS 26 or later, with matching NVAPI/NGX libraries. DLSS must be enabled in the game settings. Changes apply on the next launch. |
| DXMT support | Automatic | Automatic | Matching DXMT libraries for temporal upscaling. Automatic uses the Runtimes default. |
| Vulkan driver | Automatic; MoltenVK; KosmicKrisp | Automatic | Applies to Vulkan graphics. KosmicKrisp requires a compatible runtime, Apple Silicon and macOS 26 or later. |
| DirectDraw compatibility | On/Off | Off | Use CNC-DDraw for 32-bit games with a software DirectDraw renderer. Direct3D settings remain separate. |
| Synchronization | Automatic; MSync; Off | Automatic | Availability depends on the selected Wine version. |
| Language locale | Text |  | Optional locale identifier, such as ja_JP.UTF-8 or en_US.UTF-8. |
| Windows version | Windows 10; Windows 11; Windows 7; Windows XP | Windows 10 |  |
| Windows executable (optional) | Text |  | Relative path inside the game folder. Automatic selects the game's executable. |
| Enable BepInEx winhttp override | On/Off | Off | Load an existing winhttp.dll before Wine's built-in library. No mods or DLLs are installed. |
| Wine DLL overrides | List |  | One library=order entry per line, such as winhttp=n,b. |
| Environment variables | List |  | One NAME=value entry per line. Wine runtime and Windows environment paths are managed automatically. |
| Game arguments | List |  | One argument per line. |
| Wine debug channels (optional) | Text |  | Wine channel filters, such as -all or +seh. |

### CrossOver settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Graphics | Automatic; D3DMetal; DXMT; DXVK; WineD3D | Automatic | Availability depends on the selected CrossOver version, Mac and macOS version. |
| Game temporal integration | On/Off | Off | Expose the game's DLSS option through MetalFX Temporal. A shared temporal upscaler also enables this integration automatically. Requires Apple Silicon and DXMT on macOS 14 or later, or D3DMetal on macOS 26 or later, with matching NVAPI/NGX libraries. DLSS must be enabled in the game settings. Changes apply on the next launch. |
| DXMT support | Automatic | Automatic | Matching DXMT libraries for temporal upscaling. Automatic uses the Runtimes default. |
| Synchronization | Automatic; MSync; ESync (older CrossOver versions); Off | Automatic |  |
| Language locale | Text |  | Optional locale identifier, such as ja_JP.UTF-8 or en_US.UTF-8. |
| Windows environment | Windows 10 (64-bit); Windows 11 (64-bit); Windows 7 (64-bit); Windows XP (64-bit) | Windows 10 (64-bit) | Changing this option uses a separate Windows environment. Existing saves remain in the previous environment. |
| Windows executable (optional) | Text |  | Relative path inside the game folder. Automatic selects the game's executable. |
| Enable BepInEx winhttp override | On/Off | Off | Load an existing winhttp.dll before Wine's built-in library. No mods or DLLs are installed. |
| Wine DLL overrides | List |  | One library=order entry per line, such as winhttp=n,b. |
| Environment variables | List |  | One NAME=value entry per line. CrossOver application and bottle paths are managed automatically. |
| Game arguments | List |  | One argument per line. |
| Wine debug channels (optional) | Text |  | Wine channel filters, such as -all or +seh. |

Inspector details: Windows CPU, Executable, CrossOver application.

| Action group | Actions |
| --- | --- |
| Windows | Open Windows files |

## WOLF RPG Editor

Module `wolfrpg`.

Backends: Browser Woditor (default), CrossOver *(provider)*, Sikarugir (Wine) *(provider)*.

Runtimes tabs: WOLF RPG → WolfTL (managed); WOLF RPG → UberWolf (managed); WOLF RPG → Browser Woditor (managed).

### Browser Woditor settings

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| Hide touch controls | On/Off | On |  |
| Frame rate | 60 FPS; 30 FPS | 60 FPS |  |
| Offline protections | On/Off | On | Restrict the game to local content. |

Inspector details: Game data.

| Action group | Actions |
| --- | --- |
| Asset tools | Export project JSON; Reveal project JSON; List assets; Extract assets; Extract WOLF Pro assets; Reveal assets; Remove asset export |
