# Processor compatibility

This page lists the processor code in each runtime, translator, driver and helper that MacLauncher downloads, includes or loads, and how that code runs on an Apple Silicon Mac. The CPU of Mac code is read from the Mach-O headers of the installed files, and Windows code is named by the machine type in its PE header. Labels follow the vocabulary of [Processor builds](README.md#processor-builds). [Rosetta](ROSETTA.md) describes how Play installs Rosetta when an Intel component needs it, [System requirements](SYSTEM_REQUIREMENTS.md) gives the macOS versions, and Apple describes Rosetta's availability in [Using Intel-based apps on a Mac with Apple silicon](https://support.apple.com/en-us/102527).

## How code runs on Apple Silicon

An Apple Silicon Mac runs the code of a MacLauncher component in one of three ways:

- **Native.** Apple Silicon code, including the Apple Silicon slice of a Universal file, runs directly on the processor.
- **Rosetta.** Intel Mac code runs through Apple's Rosetta, which translates the program's instructions and lets it call macOS frameworks as before. A process runs either entirely as Intel code or entirely as Apple Silicon code, so every Mac library that an Intel process loads has to contain Intel code as well.
- **FEX inside an Apple Silicon Wine.** In a Wine whose native loader is Apple Silicon code, Wine's own Mac side runs natively and FEX translates the x64 and x86 code of Windows programs and libraries. ARM64EC and ARM64X libraries run as ARM64 code in such a process. FEX can take over from Rosetta here because Wine, itself native, supplies the Windows interfaces that the translated code calls. An Intel Mac program or library calls macOS frameworks directly, and it needs an Apple Silicon build instead.

The tables below give, for each component, the CPU of its Mac code, how it runs on Apple Silicon and the Apple Silicon alternative that MacLauncher already offers, if any. **None** marks a component that has no such alternative and therefore needs Rosetta on Apple Silicon.

## Wines

A Wine runtime runs as one native process. MacLauncher reads that process's CPU from the native Wine loader of the selected installation, never from a version number or folder name. Every Mac library that the process loads, from Wine's own drivers to the graphics translators, the Vulkan driver and the graphics helpers, has to contain code for that CPU.

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| Sikarugir engines and their Templates | Intel | Rosetta | A CrossOver installation with ARM64 Wine |
| WineCX | Intel | Rosetta | A CrossOver installation with ARM64 Wine |
| CrossOver with Intel Wine, such as CrossOver 26.3 | Intel Wine; the CrossOver application itself is Universal | Rosetta for the Wine process | A CrossOver installation with ARM64 Wine |
| CrossOver with ARM64 Wine, such as the CrossOver 27 preview | Apple Silicon | Native; FEX runs x64 and x86 Windows code | Not needed |

The Mac libraries that come with a Wine, such as its GStreamer, its CoreAudio driver and its copy of MoltenVK, have the Wine's CPU and run inside the Wine process. In Sikarugir, WineCX and CrossOver 26.3 they are Intel, except Sikarugir's MoltenVK, which is Universal. Wine Mono and Wine Gecko are Windows x64 and x86 libraries and run the way the Wine process does.

## Windows translators

A translator that consists of Windows libraries contains no Mac code. It loads into the game's Wine process and therefore runs the way that process does: under Rosetta with an Intel Wine, and under FEX in an ARM64 Wine. DXMT and D3DMetal also have a Mac part, which has to match the Wine process.

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| DXVK: upstream releases, DXVK-macOS, MacLauncher DXVK and the Sikarugir Template folders `dxvk`, `dxvk3` and `d9vk` | None; Windows x64 and x86 | With the Wine process | FEX in an ARM64 Wine |
| vkd3d-proton: upstream releases and MacLauncher vkd3d-proton | None; Windows x64 and x86 | With the Wine process | FEX in an ARM64 Wine |
| DXMT: upstream releases and Sikarugir Templates | Intel `winemetal.so`; Windows x64 and x86 libraries | Rosetta, inside an Intel Wine | None |
| D3DMetal: Apple's Game Porting Toolkit, Sikarugir Templates and CrossOver | Intel `D3DMetal.framework` and `libd3dshared.dylib`; Windows x64 libraries | Rosetta, inside an Intel Wine | None |
| WineD3D and Wine vkd3d | Part of the Wine | With the Wine process | Part of the Wine |
| cnc-ddraw, from Sikarugir Templates | None; Windows x86 | With the Wine process | FEX in an ARM64 Wine |
| DXVK-NVAPI | None; Windows x64, x86 and ARM64X | With the Wine process | ARM64X `nvapi64.dll` included |
| NGX core for DLSS forwarding | None; Windows x64 | With the Wine process | FEX in an ARM64 Wine |
| FidelityFX API adapter | None; Windows x64 | With the Wine process | FEX in an ARM64 Wine |
| Steam client bridge | Separate Apple Silicon and Intel `lsteamclient.so` libraries; Windows x64 and x86 | Intel library under Rosetta, inside an Intel Wine | Apple Silicon `lsteamclient.so` included |

## Vulkan drivers

A Vulkan driver and its loader run inside the program that uses them. For a Windows game, that program is the Wine process, whatever the architecture of the game's executable. [KosmicKrisp](KOSMICKRISP.md#cpu-builds-and-consumers) lists the build that each program loads.

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| MacLauncher KosmicKrisp | Separate Apple Silicon and Intel builds | The Apple Silicon build runs natively; the Intel build runs under Rosetta inside Intel Wines, AnyPS5 and Prosper | Apple Silicon build included in the package |
| KosmicKrisp from LWJGL | Apple Silicon | Native; never loaded by an Intel process | Not needed |
| MoltenVK from KhronosGroup releases | Universal | Native, or the Intel slice inside an Intel process | Not needed |
| MoltenVK scene support, MacLauncher's MoltenVK build | Universal | Native, or the Intel slice inside an Intel process | Not needed |

Every KosmicKrisp build needs Metal 4 on Apple Silicon, so its Intel build exists only for Intel processes running under Rosetta on an Apple Silicon Mac.

## Graphics helpers

The shared graphics layer loads into each game's process and contains both slices. Several helpers that connect Wine's Windows side to that layer are Wine libraries, which have to match the Wine process.

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| Shared graphics effects (`libreshade-macos`) and its shader compiler | Universal | Native, or the Intel slice inside an Intel process | Not needed |
| MLX neural processing | Apple Silicon | Native; Intel games use it through a separate Apple Silicon service | Not needed |
| FSR 4 model tools (`dxc`) | Universal | Native | Not needed |
| Software OpenGL helper for GameMaker | Universal | Native, or the Intel slice inside an Intel process | Not needed |
| DXMT integration for DLSS forwarding, MacLauncher's `winemetal.so` | Intel | Rosetta, inside an Intel Wine | None |
| Streamline camera forwarding, a Wine Unix library | Intel | Rosetta, inside an Intel Wine | None |
| XeSS GPU compute host, a Wine Unix library | Intel | Rosetta, inside an Intel Wine | None |
| Wine scene transport, MacLauncher's WineVulkan scene module | Intel | Rosetta, inside an Intel Wine | None |

## Game engines and runtimes

Most engines run natively on Apple Silicon. The runtimes in the first table contain Intel code, either because the runtime executes x86 code directly or because an older release was published only for Intel.

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| HashLink 1.9 and 1.12 from MacLauncher Builds, and upstream development snapshots | Intel; its JIT compiler emits Intel code | Rosetta | None |
| AnyPS5 converted games and PS5 system libraries | Intel | Rosetta | None |
| AnyPS5 converter | Separate Apple Silicon and Intel builds | Native | Not needed |
| Prosper | Intel | Rosetta | None |
| mac32 | Intel host with 32-bit Intel (i386) libraries | Rosetta | None |
| RLVM 0.14, for RealLive games | Intel | Rosetta | None |
| Older LÖVE releases built only for Intel, such as 0.10.2 | Intel | Rosetta | LÖVE 11.5, which is Universal, for games that run on it |
| Older Ren'Py SDKs whose Mac Python is Intel-only, such as 7.3.5 and 8.0.3 | Intel | Rosetta | Newer SDKs, such as 8.3.4, which is Universal, for games that run on them |
| Temurin Java 8 | Intel | Rosetta | Java 21 for Apple Silicon, which MacLauncher recommends for Java 8 bytecode; a game whose native libraries are Intel-only keeps an Intel Java |
| Steamworks bridge for Java 1.9.0 | Intel | Rosetta, with an Intel Java | None; 1.10.0 is Universal, but a game's own wrapper decides the bridge version |

The engines below have no Intel-only part:

| Component | Mac code | On Apple Silicon |
| --- | --- | --- |
| AI5-SDL2, Butterscotch, FNA with its .NET host, GemRB, Impacto, krkrsdl2, MKXP-Z, mpv, NPengine, ONScripter-EN, Onscripter-Yuri, OpenGMK, ReMinori, System3, xsystem35 and xsystem4, from MacLauncher Builds | Apple Silicon; Intel builds are published separately for most of them | Native |
| Ikemen GO, NW.js and UZDoom | Apple Silicon | Native |
| DOSBox Staging, DREAMM, EasyRPG Player, Flash Projector 35, Raze, RFVP, ScummVM and the siglus_rs host | Universal | Native |
| RLVM adapter and LuaSteam bridge | Universal | Native |
| Android runtimes: MacLauncher-Android, AIM and Mac.apk | Apple Silicon host; ARM64 and 32-bit ARM Android code | Native |
| PlayCover and the PlayTools path helper | Apple Silicon | Native |
| nxnative tools | Apple Silicon | Native |

## Launcher helpers

| Component | Mac code | On Apple Silicon | Apple Silicon alternative |
| --- | --- | --- | --- |
| MacLauncher | Separate Apple Silicon and Intel apps | The Apple Silicon app runs natively; the Intel app runs under Rosetta | Apple Silicon app |
| Included Python, launch activation module | Apple Silicon in the Apple Silicon app | Native | Not needed |
| 7-Zip (`7zz`) | Universal | Native | Not needed |
| CatSystem2 KIF decryption, APK metadata reader and renderer network isolation | Separate Apple Silicon and Intel builds | Native | Not needed |
| Android clipboard privacy helper | Apple Silicon | Native | Not needed |
| MKXP-Z configuration helper, offline Steam API helper and Steam ticket loader | Universal | Native | Not needed |
| innoextract, GM8 decompiler, System 3 and xsystem35 decompilers, ScummVM tools and the uosc helper | Apple Silicon; Intel builds are published separately | Native | Not needed |
| GDRE Tools | Universal | Native | Not needed |
| Vineflower, JADX, FFDec and Near Infinity | No native code of their own; they run in the selected Java | The Java's CPU | Not needed |
| Valve's SteamCMD, used to download Lossless Scaling models | Intel | Rosetta | None |
| Rosetta library preloader | Intel | Rosetta; runs only to prepare Intel libraries for an Intel process | Not used by Apple Silicon processes |
