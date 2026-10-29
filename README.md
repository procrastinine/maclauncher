<img src="src/renderer/src/ui/assets/maclauncher.svg" width="96" alt="MacLauncher logo">

# MacLauncher

MacLauncher is a native runtime system, graphics/effects layer, and tinker tool for playing games on macOS. tl;dr:
- [Native runtime system](#maclauncher-as-a-native-runtime-system): MacLauncher collects and automatically handles many different native macOS runtimes for a large variety of games. You can drag in some exe, it will automatically detect what engine and runtime versions should be best supported for it to run natively on macOS, and the runtime installation and management will be automatically handled for you. See the screenshot below for a small sample of what it can run natively (without [WINE](https://www.winehq.org/)/[CrossOver](https://www.codeweavers.com/crossover/)).
- [Graphics/effects layer](#maclauncher-as-a-graphics-and-effects-layer): MacLauncher includes a very powerful graphics subsystem, with neural upscaling, frame generation, [DLSS 5](https://github.com/iamwavecut/MLX-DLSS), and pretty much any custom shader you can import yourself, in any arbitrary combination (including ports of [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) and [ReShade](https://github.com/crosire/reshade) to macOS). All of this runs natively on [Metal](https://developer.apple.com/metal/) and across all runtimes.
- [Tinker tool](#maclauncher-as-a-tinker-tool): MacLauncher has a whole hosts of tools for power users. There is version management for everything, custom depot downloads for [Steam](https://store.steampowered.com/) for e.g. downloading Windows versions of games without using CrossOver, a large selection of extractors/decompilers and cheat tools, etc.

The [website](https://procrastinine.github.io/maclauncher/) has an interactive demo of the launcher and longer explanations of everything here.

![Import a game, adjust runtime and graphics settings, then play](docs/images/launcher-flow.png)

Shown: Android version of [Shattered Pixel Dungeon](https://github.com/00-Evan/shattered-pixel-dungeon) with [CRT Royale](https://github.com/akgunter/crt-royale-reshade) shaders.

## Running MacLauncher

The easiest way to run is through MacLauncher.app in the [Releases](https://github.com/procrastinine/maclauncher/releases). It is ad-hoc signed and you will need to allow it through Gatekeeper because I don't want to pay Apple $100 per year for a developer ID.

How to do it: [Open Anyway in System Settings → Privacy & Security](https://support.apple.com/en-us/102445)

You can also run [from source](#development), and everything should be the same.

# MacLauncher as a native runtime system

## Idea

A surprising number of games have runtimes that are available on macOS (and Linux) even though the games themselves are packaged for Windows and don't work out of the box. These games don't require WINE or emulation, and running natively can gain you higher performance and (sometimes) better compatibility. One of the purposes of MacLauncher is to configure these native runtimes automatically, with version management, so you can just drag in a game directory or exe and start playing with the maximally compatible version (or choose one yourself).

This launcher started by taking the patches in https://github.com/bakustarver/rpgmakermlinux-cicpoffs to macOS and wrapping it all in a UI, although I have added many more features since then. It has now gotten to the point where **a nontrivial proportion of indie games meant for Windows can just be dragged in and played without requiring WINE** (at least with the sampling bias of "indie games I personally thought of"), and similarly for iOS and Android. Still, compatibility is at the level of "try it" for many things, mainly depending on the specific runtime (for example, [Ren'Py](https://github.com/renpy/renpy) and [HTML5 RPGMaker](docs/runtimes/RUNTIMES.md) have basically perfect compatibility, but [Unity](https://unity.com/) is much more uneven).

## Why use a native runtime?

There are quite a few benefits to using native macOS runtimes for games, even when CrossOver compatibility is quite good and some developers distribute native mac builds.
- Games are generally more performant and efficient running under native runtimes compared to CrossOver/WINE.
- Compatibility is often better on native runtimes as well, although sometimes it goes the other way.
- Native runtimes have better OS integration (window management, mouse behavior, etc). I have had so much more "erratic" behavior (mouse movements not feeling right, windowed vs fullscreen mode issues or blocks, kind of corrupted sound, etc) on CrossOver, so in practice, if a game can launch in MacLauncher, I prefer to use it.
- Some .app deployments for indie games (e.g. [itch.io](https://itch.io/)) are broken because the developer just clicked "build for mac" and never test it, and the .app then runs into signing or packaging problems. This is perfectly avoidable and can be solved by just pointing a properly working runtime at its data.

This is similar in spirit to the many [decomp-recomp projects](https://github.com/SubmitGame/awesome-decomp-games) that can already be played via WINE or emulator but where people still benefit from a native runtime. As of the current version, MacLauncher doesn't provide support for these individual games as there are just so many of them (and instead focuses on _shared_ runtimes), but I am considering adding some sort of "game store" for these individual games if creating scripts for a large number of them ever becomes personally tractable.

## Game support

MacLauncher supports many game types. Please see the [module inventory](docs/MODULES.md#modules-and-backends) for details. A summary:

- **macOS apps/scripts/binaries:** these are `.app`, `.sh`, Mach-O binaries, etc, that are already made for macOS. Why would you want to run these in MacLauncher? Well, outside of using MacLauncher as a game manager, there are several reasons:
  - MacLauncher provides an easy way to remove Apple quarantine (e.g. apps showing as "damaged") and allow execution for scripts and binaries.
  - You might want to run things through this interface due to the graphics layer, e.g. you want to use DLSS or a shader on a macOS native game.
  - Excitingly, you can run **32-bit macOS binaries** that were unsupported all the way back in Catalina! This is provided through the [mac32](https://github.com/Shagulka/mac32) runtime, and although compatibility is not perfect yet, it can run e.g. [Portal 2](https://store.steampowered.com/app/620/Portal_2/).
- **Windows games:** there are many!
  - **RPGMaker:** 2000/2003 through [EasyRPG Player](https://github.com/EasyRPG/Player), MV/MZ through [Electron](https://github.com/electron/electron) or [NW.js](https://github.com/nwjs/nw.js), XP/VX/VX Ace through [MKXP-Z](https://github.com/mkxp-z/mkxp-z).
  - **HTML games:** similarly to RPGMaker MV/MZ, most games based on web technologies will "just work", including [Construct](docs/runtimes/RUNTIMES.md), [TyranoBuilder](docs/runtimes/RUNTIMES.md) and [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5).
  - **Ren'Py**
  - **[Godot](https://github.com/godotengine/godot)** (note: version matching is very important here! e.g. Godot 4.5 and 4.6 are usually not cross-compatible! Luckily MacLauncher auto-detects the version of Godot a game was made with)
  - **[LÖVE](https://github.com/love2d/love)**
  - **[GameMaker](https://gamemaker.io/):** you can use the official GameMaker runtime, or alternatively, [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) for GameMaker Studio and [OpenGMK](https://github.com/OpenGMK/OpenGMK) for GameMaker classic (custom macOS port).
  - **Unity:** Mono games can usually run through the macOS Unity player and are supported in MacLauncher (similarly to Godot, version management is important, and MacLauncher does it for you). [Il2Cpp](https://docs.unity3d.com/Manual/IL2CPP.html) translates everything into system calls so you need WINE for that. Basically, some Unity games (the ones having little Windows-specific code) work, others do not.
  - **[XNA/FNA](docs/runtimes/FNA.md):** with [FNA](https://github.com/FNA-XNA/FNA), [FNA3D](https://github.com/FNA-XNA/FNA3D), [FAudio](https://github.com/FNA-XNA/FAudio) and [.NET](https://github.com/dotnet/runtime).
  - **[WOLF RPG](docs/runtimes/WOLFRPG.md):** with [Browser Woditor](https://frostyhowl.com/browser-woditor/).
  - **Flash (`.swf`):** via [Adobe Flash Projector](docs/runtimes/RUNTIMES.md#ruffle--flash-player) or [Ruffle](https://github.com/ruffle-rs/ruffle)
  - **Java:** with [Temurin](https://github.com/adoptium/temurin-build) version management, [Vineflower](https://github.com/Vineflower/vineflower) decompilation, and [steamworks4j](https://github.com/code-disaster/steamworks4j).
  - **Infinity Engine:** [GemRB](https://github.com/gemrb/gemrb).
  - **Adventure games:** with [ScummVM](https://github.com/scummvm/scummvm).
  - **MUGEN:** [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO).
  - **[Haxe](https://haxe.org/):** [HashLink](https://github.com/HaxeFoundation/hashlink).
  - **DOS games:** through [DOSBox Staging](https://www.dosbox-staging.org/), including DOS `.exe`, `.com`. This one _is_ emulation which is "fine" because the resource needs are so low.
  - **Visual novels**: there are a lot. Surprisingly many VN engines get cross-platform runtimes. Here is what MacLauncher currently supports:
    - **NScripter:** [Onscripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri), and a custom macOS port of [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN).
    - **KiriKiri / KAG:** [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) and [KAG3](https://github.com/krkrsdl2/kag3).
    - **MAGES:** [Impacto](https://github.com/CommitteeOfZero/impacto)
    - **AI5WIN:** [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2).
    - **AliceSoft:** [System3](https://github.com/kichikuou/system3-sdl2), [xsystem35](https://github.com/kichikuou/xsystem35-sdl2), and [xsystem4](https://github.com/nunuhara/xsystem4).
    - **Siglus / RealLive:** [siglus_rs](https://github.com/xmoezzz/siglus_rs) and [RLVM](https://github.com/eglaysher/rlvm) (RealLive-only for the latter).
    - **Nitroplus:** [NPengine](https://github.com/FGRE/libnpengine) and [libnpa](https://github.com/FGRE/libnpa).
    - **Minori:** [ReMinori](https://github.com/luoyily/ReMinori).
    - **FAVORITE / FVP:** [RFVP](https://github.com/xmoezzz/rfvp)
    - **VNDS:** [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE).
  - **Other Windows executables:** you can provide a local CrossOver application to run any Windows executable, and you can manage multiple versions of it. Or alternatively if you don't have CrossOver, MacLauncher can also manage the free [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) for you, which is largely the same thing (WINE with graphics translation layers). There are some convenient options built in, such as easy options to set the locale and a workaround for [BepinEx](https://github.com/BepInEx/BepInEx) to work, as well as the standard graphics options and WINE flags. See the [CrossOver guide](docs/runtimes/CROSSOVER.md) for details.
- **Mobile games:** we have runtimes that run things natively (like WINE), not through emulation!
  - **iOS / iPadOS:** through [PlayCover](https://github.com/PlayCover/PlayCover), or more specifically [PlayTools](https://github.com/PlayCover/PlayTools)
  - **Android, or ARM64 VR/XR:** MacLauncher offers the [Mac.apk](https://github.com/kksimp/Mac.apk) and [AIM](https://github.com/hahnlee/aim) runtimes, both of which can play `.apk` on mac through what is basically Java. In addition, MacLauncher itself offers the [MacLauncher-Android](https://github.com/procrastinine/maclauncher-android) runtime which is specifically for games and (in my testing) more compatible with complex commercial games (think [Roblox](https://www.roblox.com/) or [Hungry Shark Evolution](https://www.ubisoft.com/en-us/game/hungry-shark/evolution) or the like), plus compatible with VR/XR (e.g. [Beat Saber](https://www.beatsaber.com/)) due to being built on [Klepton](https://github.com/shinyquagsire23/Klepton).
- **Game consoles:** again, native, not emulated
  - **PlayStation 5:** through [AnyPS5](https://github.com/boykopovar/AnyPS5), which converts PS5 executables into macOS binaries and runs them through [Rosetta](https://support.apple.com/en-us/102527) on Apple Silicon. MacLauncher handles conversion, runtime versions, [the Vulkan driver](docs/runtimes/ANYPS5.md), and keyboard/mouse/controller settings. This requires unpacked, decrypted game files and macOS 26+. There is also an optional [Prosper](https://github.com/mattias800/prosper) backend if you provide a local macOS build. See the [PS5](docs/runtimes/ANYPS5.md) and [Prosper](docs/runtimes/PROSPER.md) guides for details.
  - **Nintendo Switch:** through [nxnative](https://github.com/seedds/nxnative), running ARM64 game code on Apple Silicon with Metal graphics. You can import `.nsp`, `.nsz`, `.xci` or `.xcz` games, and MacLauncher handles extraction, preparation, runtime versions and shader compilation. Encrypted games need your own `prod.keys`. See the [Switch guide](docs/runtimes/NXNATIVE.md) for details.
- **Videos:** it is kind of funny but you can play videos through MacLauncher via [mpv](https://github.com/mpv-player/mpv), which is useful due to the whole graphics layer meaning we can upscale and apply effects on videos as well as games. MacLauncher supports mpv plugins (by default, [uosc](https://github.com/tomasklaen/uosc) and [thumbfast](https://github.com/po5/thumbfast)) but you can add any yourself, and also supports playlists in folders, saved watch positions, and subtitles. You can also preview and export videos with effects applied; see the [video guide](docs/runtimes/VIDEO.md).

Missing runtimes can be downloaded when you press Play, after asking for permission, and then the game preparation and launch continue automatically. Installed versions stay available offline, and you can keep different versions for different games.

## Unique features

Most of the above runtimes are existing tools with MacLauncher managing them. However, there is also a significant amount of functionality and compatibility that you can't find anywhere else. Here are some highlights:
- The previously mentioned macOS runtime for Android and VR/XR games (see MacLauncher-Android).
- A port of [OpenGMK to macOS](docs/runtimes/GAMEMAKER.md#classic-opengmk): involving [AppKit](https://developer.apple.com/documentation/appkit) input/windows, [OpenGL](https://www.khronos.org/opengl/), [CoreAudio](https://developer.apple.com/documentation/coreaudio) and original-read/private-write handling. As far as I know, this is the only way to get GameMaker classic games running natively on mac.
- Similarly, a [macOS port of AnyPS5](docs/runtimes/ANYPS5.md).
- Also, custom macOS ports of [ONScripter-EN](docs/runtimes/NSCRIPTER.md), [AI5](docs/runtimes/AI5.md), [KAG3](docs/runtimes/VN_ENGINES.md), and [ReMinori](docs/runtimes/MINORI.md).
- Automatic [offline Steam API support](docs/runtimes/STEAM_API.md) (for things needing Steam API before play).

# MacLauncher as a graphics and effects layer

Maybe _the_ most useful thing about MacLauncher is that it provides a very powerful graphics postprocessing system where you can control _exactly what_ graphics/effects you apply, with very broad support. All of these effects run on native Metal, **not** WINE, and work across **any** runtime you want to use inside MacLauncher. i.e., you could literally drag Microsoft Word into MacLauncher and apply GFX to it lmao. Here is what's included:
- **Upscaling:**
  - **Spatial:** [MetalFX Spatial](https://developer.apple.com/documentation/metalfx), [AMD FSR 1](https://github.com/GPUOpen-Effects/FidelityFX-FSR), [Lossless Scaling LS1](docs/runtimes/GRAPHICS.md#lossless-scaling-setup) (you have to provide your own copy of Lossless Scaling), plus traditional upscaling algorithms, [libplacebo filters](docs/graphics/PROVIDERS.md#spatial-resizing) and [Mako](https://github.com/eugeniosegala/MAKO).
  - **Temporal:** [MetalFX Temporal](https://developer.apple.com/documentation/metalfx) (including [its denoised version](https://developer.apple.com/documentation/metalfx/mtlfxtemporaldenoisedscaler)), AMD [FSR 2.2](https://github.com/GPUOpen-Effects/FidelityFX-FSR2)/[3.1/4.1](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), [Arm ASR](https://github.com/arm/accuracy-super-resolution-generic-library), [Snapdragon GSR 2](https://github.com/SnapdragonGameStudios/snapdragon-gsr), [Intel XeSS](https://github.com/intel/xess) and [DLSS SR](https://github.com/iamwavecut/MLX-DLSS). [FSR 4](https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos) includes [Exact Fast, Lite and Lite2 profiles](docs/graphics/PROVIDERS.md#scene-temporal-upscaling). DLSS SR has separate image-history and scene-input models.
  - **Neural:** [RTX Video Super Resolution](https://github.com/iamwavecut/MLX-DLSS), [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (4x) and [Real-CUGAN](https://github.com/bilibili/ailab/tree/main/Real-CUGAN) (2x/3x/4x).
  - **Shader upscalers:** whatever mpv shaders you want to provide (e.g. CNN or [Anime4k](https://github.com/bloc97/Anime4K) upscalers). Downloadable shader collections include [ArtCNN](https://github.com/Artoriuz/ArtCNN), [CuNNy](https://github.com/funnyplanter/CuNNy), [ACNet/ARNet](https://github.com/TianZerL/ACNetGLSL), [FSRCNNX](https://github.com/iwalton3/default-shader-pack), [RAVU](https://github.com/bjin/mpv-prescalers) and [NNEDI3](https://github.com/bjin/mpv-prescalers), as well as pixel-art scalers like [xBRZ](https://github.com/libretro/slang-shaders/tree/master/edge-smoothing/xbrz) and [SABR](https://github.com/libretro/slang-shaders/tree/master/edge-smoothing/sabr).
- **Frame generation:** [Lossless Scaling LSFG](docs/runtimes/GRAPHICS.md#lossless-scaling-setup), [MetalFX](https://developer.apple.com/documentation/metalfx), [FSR 3](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), Intel XeSS, [MLX interpolation](https://github.com/iamwavecut/MLX-DLSS) and [RIFE](https://github.com/hzwer/Practical-RIFE). [LSFG](docs/runtimes/GRAPHICS.md#frame-generation), MLX interpolation and RIFE work from consecutive images, so they don't need the game's depth or motion vectors. Frame generation adds displayed frames, without speeding up the game simulation.
- **Neural reconstruction and restoration:**
  - **Reconstruction:** DLSS 5, via MLX-DLSS.
  - **Restoration:** [NAFNet](https://github.com/megvii-research/NAFNet) denoising/deblurring cleans up the image at its existing resolution. See the [restoration guide](docs/NEURAL_RESTORATION.md).
  - **Models:** you can [download supported models](docs/GRAPHICS.md#neural-models) or [import your own compatible model packages](docs/GRAPHICS.md#neural-models), and choose different models for different steps in the pipeline.
- **Shaders and effects:** any shader you provide in ReShade, [RetroArch Slang](https://github.com/libretro/slang-shaders), and mpv/[libplacebo](https://code.videolan.org/videolan/libplacebo), plus [MagpieFX](https://github.com/Blinue/Magpie) and [ISF](https://github.com/Vidvox/ISF-Files), including setting any shader parameters. For those unfamiliar, these include things like CRT effects, depth effects, color postprocessing, etc. A sample of the effects included with MacLauncher, which can be supplemented with whatever you choose:
  - **Image effects:** CRT Royale and other CRT shaders, [SMAA](https://github.com/iryoku/smaa)/[CMAA2](https://github.com/GameTechDev/CMAA2) antialiasing, [bloom](https://github.com/martymcmodding/qUINT), [sharpening](https://github.com/CeeJayDK/SweetFX), [debanding](https://github.com/martymcmodding/qUINT), [color grading/LUTs](https://github.com/prod80/prod80-ReShade-Repository), [histogram auto exposure](docs/graphics/PROVIDERS.md#shader-formats-and-image-effects), [film grain](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), [lens effects](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), [Gaussian blur](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), [anisotropic Kuwahara](https://github.com/jkyprian/gpuakf) (the painterly effect), [local Laplacian](https://github.com/halide/Halide/blob/d62903bbf5166e05841e1346837c8367e2296a83/apps/local_laplacian/local_laplacian_generator.cpp) detail/contrast, and [colorblindness correction](src/modules/shared/reshade/shader-collection/accessibility/daltonize.fx).
  - **Depth/lighting effects:** [XeGTAO](https://github.com/GameTechDev/XeGTAO) and [AMD CACAO](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) ambient occlusion, [FidelityFX depth of field](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), [screen-space reflections](docs/graphics/PROVIDERS.md#shader-formats-and-image-effects), [visibility-bitmask indirect lighting](https://github.com/cdrinmatane/SSRT3), [depth fog and outlines](docs/graphics/PROVIDERS.md#shader-formats-and-image-effects). These use actual scene depth/camera data, plus normals/material/lighting data where needed. There is also image-based fog using [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), for when you only have the final image.
  - **Shader collections:** included and downloadable collections cover [qUINT](https://github.com/martymcmodding/qUINT), [CShade](https://github.com/papadanku/CShade), [prod80](https://github.com/prod80/prod80-ReShade-Repository), [FXShaders](https://github.com/luluco250/FXShaders) and [NiceGuy shaders](https://github.com/mj-ehsan/NiceGuy-Shaders).
- **Output controls:** [tone mapping](docs/GRAPHICS.md#generation-and-output) (Automatic, None, Reinhard or PBR Neutral), [HDR/wide-gamut color handling](docs/graphics/FRAME_API.md#color-alpha-and-time-domains), [frame pacing](docs/GRAPHICS.md#generation-and-output), [black-frame insertion](docs/GRAPHICS.md#generation-and-output) and [CRT beam scheduling](docs/GRAPHICS.md#generation-and-output). There is also a live [source/processed split and difference view](docs/GRAPHICS.md#generation-and-output), so you can see what your effects are actually doing.
- **Live switching:** for all of these, we can live switch what effects we apply, in both windowed and fullscreen modes (or switching in between the two), without restarting the game.

Scene-based temporal upscaling and frame generation need matching depth, motion and other inputs from the game renderer. The available choices also depend on the macOS version and GPU; see the [graphics providers](docs/graphics/PROVIDERS.md) for the specific requirements. LS1/LSFG use your own purchased Lossless Scaling copy, which can be imported or downloaded through Steam from the Runtimes panel.

The UI has **[Simple](docs/GRAPHICS.md#the-graphics-chain)** and **[Advanced](docs/GRAPHICS.md#the-graphics-chain)** views of the same pipeline. Simple gives you dropdowns for image filters, resizing and temporal effects; Advanced lets you add and reorder individual steps. Switching between them keeps your settings. You can save a whole chain as a [preset](docs/GRAPHICS.md#the-graphics-chain) and apply it to other games, or turn Graphics off while keeping everything for later. [Shader collections](docs/GRAPHICS.md#shader-library), model downloads/imports and default choices are managed in [Runtimes → Graphics](docs/GRAPHICS.md).

[Processing sizes](docs/GRAPHICS.md#rendering-processing-and-output-size) are also configurable at each step: a fraction of the previous image, a fraction of the window/fullscreen size, or a fixed width/height (e.g. 540p). The window can stay the same size while the effects run at a different resolution. [Game render resolution](docs/graphics/FRAME_API.md#game-render-allocation-and-processing-extent) is a separate control, so downsampling an already rendered image reduces the work for the effects that follow it, without making the game itself render faster.

Furthermore, the powerful part of MacLauncher is that it not only is able to apply these effects, but is able to apply them in **any order, and any combination.** Take the following use case, for example:
- We want to use DLSS 5 to see what games can look like when we try to make them "realistic".
- However, DLSS 5 is slow as hell, especially on my wimpy MacBook from the M2 generation with no neural accelerators. It is completely unplayable if we just try to apply it.
- Thus, we can apply a pipeline: first, render or downsample the game at ~720p, run DLSS 5 on 720p, then upsample (e.g. using MetalFX) to your actual screen resolution (e.g. 4k), which can all be handled through stacking effects in MacLauncher.
- It turns out that my wimpy MacBook struggles even like this, hitting an abysmal 15fps or so even DLSS-ing at 720p, so "real time" but not pleasant. Therefore, you can _then_ apply Lossless Scaling frame generation, say 4x, yielding 60fps. I tried it, and yes it is "smooth". Now, would I want to play competitive games with this? Hell no, the input latency is crap, frame generation isn't perfect, and upscaling ultimately makes the image lose detail (although it is often pretty good). But is it _fun_ to mess with DLSS and be able to play the game? In my opinion, absolutely.
- If you additionally want to change the colors or make it look like it came out of a CRT, you can play with whatever shaders you want on top of that.
- And notice in this process what you can do:
  - Change any parameters you want (e.g. DLSS strength, how much to upscale, shader parameters) in any step of the process
  - Change the pipeline in any way while looking at the game window, live, for the change in effects, without having to go out of the game or restart
  - And this applies for all games! Whatever macOS `.app`, something running on CrossOver, a browser game, [Android/iOS](docs/GRAPHICS_PIPELINE.md), visual novels, whatever you want!

## Unique features

A lot of these graphics features are custom ports to macOS that are again found nowhere else and are unique to MacLauncher. For example:
- The [graphics layer](docs/GRAPHICS_PIPELINE.md) itself: custom macOS ports of Lossless Scaling and ReShade, with neural models, shaders, upscaling and frame generation all in one pipeline. The interesting part is being able to combine all of these, in whatever order you want, across the different runtimes, and change them live while looking at the game.
  - [Lossless Scaling macOS port](docs/runtimes/GRAPHICS.md#lossless-scaling-setup)
  - [ReShade macOS port](src/modules/shared/reshade/native/README.md)
- Native Metal ports of [AMD FSR 1/2/3/4](docs/graphics/PROVIDERS.md), Arm ASR and Snapdragon GSR 2, using the same graphics layer. These include temporal upscaling and FSR 3 frame generation, with the game's actual depth/motion inputs.
- [MLX neural processing for Intel games too](docs/graphics/PROVIDERS.md#neural-rendering-restoration-and-image-upscaling): the game can be running under Rosetta or CrossOver while an Apple Silicon helper runs the neural models on the GPU.

Some other graphics implementations/adaptations in MacLauncher:

- RIFE 4.6 frame interpolation, adapted to run through [MLX](https://github.com/ml-explore/mlx)/Metal in the same pipeline as everything else.
- Real-ESRGAN and NAFNet upscaling/restoration, building on existing [Real-ESRGAN MLX](https://github.com/xocialize/mlx-realesrgan-swift) and [NAFNet MLX](https://github.com/xocialize/mlx-nafnet-swift) ports and adapted into the shared [model runtime and live graphics pipeline](docs/NEURAL_RESTORATION.md).
- A Real-CUGAN implementation on MLX/Metal, using its original 2x/3x/4x models.
- Depth Anything V2 Small on MLX/Metal, used for [image-based depth fog](docs/graphics/PROVIDERS.md#shader-formats-and-image-effects).
- Native Metal ports of CMAA2 antialiasing, XeGTAO ambient occlusion, and AMD CACAO, FidelityFX depth of field, Lens and Blur.
- GPU adaptations of anisotropic Kuwahara (the painterly effect) and Halide's local Laplacian filter (detail/contrast).
- [Godot's screen-space reflections](https://github.com/godotengine/godot), SSRT3 indirect lighting, and [FXShaders depth fog/outlines](https://github.com/luluco250/FXShaders), adapted into the shared graphics layer.
- MagpieFX shader translation and execution on Metal, so its image filters and upscalers can be used alongside the other effects.

# MacLauncher as a tinker tool

I guess the main "philosophy" of MacLauncher is that these are _your_ games, locally, and the job of MacLauncher is to help you do whatever you want with them, i.e. to give the user maximum control over everything possible. As such, the whole model is that MacLauncher uses local files, downloads what you want via version managers, and offers very fine-grained settings. Some things I want to highlight:
- There are very granular settings for most runtimes and game types. I generally like passing all parameters in so you can set whatever launch flags you want, basically, anything the runtime (or graphics or whatever) allows, you can set. You can also set custom launch flags. Or for example, every game lets you disable network access.
- Whenever possible, for everything (runtimes, games, graphics, accounts, whatever), I try to make the version management as robust as possible. Any downloadable runtime versions can be selected and used, you can manage multiple google accounts for [google play](https://play.google.com/store/games) or steam accounts for steam integration or whatever, we try to detect what runtime version a game uses as much as possible, etc etc. In short, you can always control exactly what version of everything you use, which is important for compatibility (but we also try to make the defaults as seamless as possible).
- There is a huge host of "tools"—stuff like decompilers/asset viewers, save editors, cheats (especially for RPGMaker and Ren'Py games where a universal cheat is possible)—for as many game types as we could find them for. Most runtimes will have some type of extraction available, once again see [MODULES.md](docs/MODULES.md) for details.
- There is also a very convenient storefront integration. Currently, we support Steam, [GOG](https://www.gog.com/), [Epic](https://store.epicgames.com/), Itch.io, Google Play, and [F-Droid/IzzyOnDroid](docs/GOOGLE_PLAY.md#f-droid-and-izzyondroid), and you are able to download any games you own (or are free) from MacLauncher itself. The special part about this feature is that, as much as possible, we allow you to download whatever version of games you want. For example, the Steam launcher might not allow you to download Windows versions of a game on mac, but MacLauncher lets you download whatever you want, including Windows, or Linux, or mac 32-bit, or any previous version of the game if you have the depot ID (e.g. through [SteamDB](https://steamdb.info/)). Or for example, you can sign in to however many accounts you want and are not restricted to one account.
- MacLauncher will never have user-hostile anti-features, or violate privacy. Every single network call is from a specific user interaction (e.g. refreshing upstream versions of stuff), without any background network calls or network call from navigating to some tab.

# Development

MacLauncher is built on Electron. Yes I know, Electron bad, Electron waste RAM in RAM crisis, Electron = npm supply chain attacks and left pad and react bloat, etc. Believe it or not, however, Electron was actually a conscious decision for this project for the following reasons (possibly cope):
- So browser-based games (a significant chunk of games) can play without external runtime downloads.
- Because I might want to port this to Linux or Android (maybe even parts to iOS) in the future and some sort of a shared codebase would be nice.
- Because the launcher actually doesn't matter that much for performance: after importing games, you don't actually need to use the Electron launcher at all, you can just save the game config as a `.command` and open it without going through Electron UI at all.
- As a bonus, we can have a demo on the [website](https://procrastinine.github.io/maclauncher/demo/)!

Anyways, the requirements for dev are [Node.js](https://nodejs.org/en/download) 22.12+, 24 or 26 and [pnpm](https://pnpm.io/installation). The source setup commands are:

```sh
git clone https://github.com/procrastinine/maclauncher.git
cd maclauncher
node scripts/init-submodules.cjs
pnpm install --frozen-lockfile
pnpm dev
```

To update, use `git pull --no-recurse-submodules`, `node scripts/init-submodules.cjs` and `pnpm install --frozen-lockfile`.

To build, use `pnpm package:mac`.

I am trying to minimize supply chain attacks here, so usually packages must be at least 1 week old for me to include. Therefore I would call this safer to install and run than most Node.js projects, but out of caution, I do most development on a [VM](https://github.com/procrastinine/second_mac).

Launcher data and installed runtimes live in `~/Library/Application Support/maclauncher/`. `pnpm launch --game /path/to/game --wait` launches a game without the library window; `--inspect` reads its metadata.

To keep the core launcher itself as light as possible, there is the accompanying project [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) for runtime binaries and the custom builds that should be used for MacLauncher (you should use these through the "Runtimes" panel in the UI).

MacLauncher is **alpha software!** Things might be unstable or stupid, it is heavily written with LLMs and is so far only tested on my computer.

# Docs

- [User guide](docs/README.md)
- [Runtime guides](docs/runtimes/README.md)
- [Graphics and effects](docs/GRAPHICS.md)
- Graphics providers
- [Tools and saves](docs/README.md#saves-cheats-and-source-tools)
- [Attributions](docs/ATTRIBUTIONS.md)
- [Backend and CLI](docs/BACKEND.md)
- [Development and app builds](docs/DEVELOPMENT.md)
- [Repository guide](docs/REPO_GUIDE.md)

# License

See [attributions](docs/ATTRIBUTIONS.md) for what existing projects I used and the licenses they have (mostly open source stuff). MacLauncher itself is [MIT licensed](LICENSE).
