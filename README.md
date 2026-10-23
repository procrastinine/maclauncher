<img src="src/renderer/src/ui/assets/maclauncher.svg" width="96" alt="MacLauncher logo">

# MacLauncher

MacLauncher is a native runtime system, graphics/effects layer, and tinker tool for playing games on macOS. tl;dr:
- [Native runtime system](#maclauncher-as-a-native-runtime-system): MacLauncher collects and automatically handles many different native macOS runtimes for a large variety of games. You can drag in some exe, it will automatically detect what engine and runtime versions should be best supported for it to run natively on macOS, and the runtime installation and management will be automatically handled for you. See the screenshot below for a small sample of what it can run natively (without WINE/CrossOver).
- [Graphics/effects layer](#maclauncher-as-a-graphics-and-effects-layer): MacLauncher includes a very powerful graphics subsystem, with neural upscaling, frame generation, DLSS 5, and pretty much any custom shader you can import yourself, in any arbitrary combination (including ports of Lossless Scaling and ReShade to macOS). All of this runs natively on Metal and across all runtimes.
- [Tinker tool](#maclauncher-as-a-tinker-tool): MacLauncher has a whole hosts of tools for power users. There is version management for everything, custom depot downloads for Steam for e.g. downloading Windows versions of games without using CrossOver, a large selection of extractors/decompilers and cheat tools, etc.

![Import a game, adjust runtime and graphics settings, then play](docs/images/launcher-flow.png)

Shown: Android version of [Shattered Pixel Dungeon](https://github.com/00-Evan/shattered-pixel-dungeon) with CRT Royale shaders.

## Running MacLauncher

The easiest way to run is through MacLauncher.app in the [Releases](https://github.com/procrastinine/maclauncher/releases). It is ad-hoc signed and you will need to allow it through Gatekeeper because I don't want to pay Apple $100 per year for a developer ID.

How to do it: [Open Anyway in System Settings → Privacy & Security](https://support.apple.com/en-us/102445)

You can also run [from source](#development), and everything should be the same.

# MacLauncher as a native runtime system

## Idea

A surprising number of games have runtimes that are available on macOS (and Linux) even though the games themselves are packaged for Windows and don't work out of the box. These games don't require WINE or emulation, and running natively can gain you higher performance and (sometimes) better compatibility. One of the purposes of MacLauncher is to configure these native runtimes automatically, with version management, so you can just drag in a game directory or exe and start playing with the maximally compatible version (or choose one yourself).

This launcher started by taking the patches in https://github.com/bakustarver/rpgmakermlinux-cicpoffs to macOS and wrapping it all in a UI, although I have added many more features since then. It has now gotten to the point where **a nontrivial proportion of indie games meant for Windows can just be dragged in and played without requiring WINE** (at least with the sampling bias of "indie games I personally thought of"), and similarly for iOS and Android. Still, compatibility is at the level of "try it" for many things, mainly depending on the specific runtime.

## Why use a native runtime?

There are quite a few benefits to using native macOS runtimes for games, even when CrossOver compatibility is quite good and some developers distribute native mac builds.
- Games are generally more performant and efficient running under native runtimes compared to CrossOver/WINE.
- Compatibility is often better on native runtimes as well, although sometimes it goes the other way.
- Native runtimes have better OS integration (window management, mouse behavior, etc). I have had so much more "erratic" behavior (mouse movements not feeling right, windowed vs fullscreen mode issues or blocks, kind of corrupted sound, etc) on CrossOver, so in practice, if a game can launch in MacLauncher, I prefer to use it.
- Some .app deployments for indie games (e.g. itch.io) are broken because the developer just clicked "build for mac" and never test it, and the .app then runs into signing or packaging problems. This is perfectly avoidable and can be solved by just pointing a properly working runtime at its data.

This is similar in spirit to the many [decomp-recomp projects](https://github.com/SubmitGame/awesome-decomp-games) that can already be played via WINE or emulator but where people still benefit from a native runtime. As of the current version, MacLauncher doesn't provide support for these individual games as there are just so many of them (and instead focuses on _shared_ runtimes), but I am considering adding some sort of "game store" for these individual games if creating scripts for a large number of them ever becomes personally tractable.

## Game support

MacLauncher supports many game types. Please see the [module inventory](docs/MODULES.md#modules-and-backends) for details. A summary:

- **macOS apps/scripts/binaries:** these are `.app`, `.sh`, Mach-O binaries, etc, that are already made for macOS. Why would you want to run these in MacLauncher? Well, outside of using MacLauncher as a game manager, there are several reasons:
  - MacLauncher provides an easy way to remove Apple quarantine (e.g. apps showing as "damaged") and allow execution for scripts and binaries.
  - You might want to run things through this interface due to the graphics layer, e.g. you want to use DLSS or a shader on a macOS native game.
  - Excitingly, you can run **32-bit macOS binaries** that were unsupported all the way back in Catalina! This is provided through the [mac32](https://github.com/Shagulka/mac32) runtime, and although compatibility is not perfect yet, it can run e.g. Portal 2.
- **Mobile games:**
  - **iOS / iPadOS:** through [PlayCover](https://github.com/PlayCover/PlayCover), or more specifically [PlayTools](https://github.com/PlayCover/PlayTools)
  - **Android, or ARM64 VR/XR:** MacLauncher offers the [Mac.apk](https://github.com/kksimp/Mac.apk) and [AIM](https://github.com/hahnlee/aim) runtimes, both of which can play `.apk` on mac through what is basically Java. In addition, MacLauncher itself offers the [MacLauncher-Android](https://github.com/procrastinine/maclauncher-android) runtime which is specifically for games and (in my testing) more compatible with complex commercial games (think Roblox or Hungry Shark Evolution or the like), plus compatible with VR/XR (e.g. Beat Saber) due to being built on [Klepton](https://github.com/shinyquagsire23/Klepton).
- **Windows games:** there are many!
  - **RPGMaker:** 2000/2003 through [EasyRPG Player](https://github.com/EasyRPG/Player), MV/MZ through [Electron](https://github.com/electron/electron) or [NW.js](https://github.com/nwjs/nw.js), XP/VX/VX Ace through [MKXP-Z](https://github.com/mkxp-z/mkxp-z).
  - **HTML games:** similarly to RPGMaker MV/MZ, most games based on web technologies will "just work", including Construct, TyranoBuilder and GameMaker HTML5.
  - **Ren'Py**
  - **Godot** (note: version matching is very important here! e.g. Godot 4.5 and 4.6 are usually not cross-compatible! Luckily MacLauncher auto-detects the version of Godot a game was made with)
  - **LÖVE**
  - **GameMaker:** you can use the official GameMaker runtime, or alternatively, [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) for GameMaker Studio and [OpenGMK](https://github.com/OpenGMK/OpenGMK) for GameMaker classic (custom macOS port).
  - **Unity:** Mono games can usually run through the macOS Unity player and are supported in MacLauncher (similarly to Godot, version management is important, and MacLauncher does it for you). Il2Cpp translates everything into system calls so you need WINE for that.
  - **XNA/FNA:** with [FNA](https://github.com/FNA-XNA/FNA), [FNA3D](https://github.com/FNA-XNA/FNA3D), [FAudio](https://github.com/FNA-XNA/FAudio) and [.NET](https://github.com/dotnet/runtime).
  - **WOLF RPG:** with [Browser Woditor](https://frostyhowl.com/browser-woditor/).
  - **Flash (`.swf`):** via Adobe Flash Projector or [Ruffle](https://github.com/ruffle-rs/ruffle)
  - **Java:** with [Temurin](https://github.com/adoptium/temurin-build) version management, [Vineflower](https://github.com/Vineflower/vineflower) decompilation, and [steamworks4j](https://github.com/code-disaster/steamworks4j).
  - **Infinity Engine:** [GemRB](https://github.com/gemrb/gemrb).
  - **Adventure games:** with [ScummVM](https://github.com/scummvm/scummvm).
  - **MUGEN:** [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO).
  - **Haxe:** [HashLink](https://github.com/HaxeFoundation/hashlink).
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
  - **Other Windows executables:** you can provide a local [CrossOver](https://www.codeweavers.com/crossover/) application to run any Windows executable, and you can manage multiple versions of it. Or alternatively if you don't have CrossOver, MacLauncher can also manage the free [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) for you, which is largely the same thing (WINE with graphics translation layers). There are some convenient options built in, such as easy options to set the locale and a workaround for BepinEx to work, as well as the standard graphics options and WINE flags. See the [CrossOver guide](docs/runtimes/CROSSOVER.md) for details.
- **Videos:** it is kind of funny but you can play videos through MacLauncher via [mpv](https://github.com/mpv-player/mpv), which is useful due to the whole graphics layer meaning we can upscale and apply effects on videos as well as games.

## Unique features

Most of the above runtimes are existing tools with MacLauncher managing them. However, there is also a significant amount of functionality and compatibility that you can't find anywhere else. Here are some highlights:
- The previously mentioned macOS runtime for Android and VR/XR games (see [MacLauncher-Android](https://github.com/procrastinine/maclauncher-android)).
- A port of [OpenGMK to macOS](docs/runtimes/GAMEMAKER.md#classic-opengmk): involving AppKit input/windows, OpenGL, CoreAudio and original-read/private-write handling. As far as I know, this is the only way to get GameMaker classic games running natively on mac.
- Also, custom macOS ports of [ONScripter-EN](docs/runtimes/NSCRIPTER.md), [AI5](docs/runtimes/AI5.md), [KAG3](docs/runtimes/VN_ENGINES.md), and [ReMinori](docs/runtimes/MINORI.md).
- Automatic [offline Steam API support](docs/runtimes/STEAM_API.md) (for things needing Steam API before play).

# MacLauncher as a graphics and effects layer

Maybe _the_ most useful thing about MacLauncher is that it provides a very powerful graphics postprocessing system where you can control _exactly what_ graphics/effects you apply, with very broad support. All of these effects run on native Metal, **not** WINE, and work across **any** runtime you want to use inside MacLauncher. Here is a list of included graphics:
- **Spatial upscaling:** MetalFX Spatial, AMD FSR 1, Lossless Scaling LS1 (you have to provide your own copy of Lossless Scaling), plus traditional upscaling algorithms, Mako, and whatever mpv shaders you want to provide (e.g. CNN or Anime4k upscalers).
- **Temporal upscaling/frame generation:** MetalFX Temporal, AMD FSR 2.2/3.1/4.1, Lossless Scaling LSFG
- **Other shaders/effects:** any shader you provide in ReShade, RetroArch Slang, and mpv/libplacebo, including setting any shader parameters. For those unfamiliar, these include things like CRT effects, depth effects, color postprocessing, etc.
- **Neural reconstruction:** DLSS 5, via [MLX-DLSS](https://github.com/iamwavecut/MLX-DLSS).
- For all of these: we can live switch what effects we apply, in both windowed and fullscreen modes (or switching in between the two), without restarting the game.

Furthermore, the powerful part of MacLauncher is that it not only is able to apply these affects, but is able to apply them in **any order, and any combination.** Take the following use case, for example:
- We want to use DLSS 5 to see what games can look like when we try to make them "realistic".
- However, DLSS 5 is slow as hell, especially on my wimpy MacBook from the M2 generation with no neural accelerators. It is completely unplayable if we just try to apply it.
- Thus, we can apply a pipeline: first, render or downsample the game at ~540p (half of 1080p), run DLSS 5 on 540p, then upsample (e.g. using MetalFX) to your actual screen resolution (e.g. 4k), which can all be handled through stacking effects in MacLauncher.
- It turns out that my wimpy MacBook struggles even like this, hitting an abysmal 15fps or so even DLSS-ing at 540p. Therefore, you can _then_ apply Lossless Scaling frame generation, say 4x, yielding 60fps. I tried it, and yes it is "smooth". Now, is this a good gameplay experience? Hell no, the input latency is crap, frame generation isn't perfect, and upscaling ultimately makes the image lose detail. But is it _fun_ to mess with DLSS and be able to play the game? In my opinion, absolutely.
- If you additionally want to change the colors or make it look like it came out of a CRT, you can play with whatever shaders you want on top of that.
- And notice in this process what you can do:
  - Change any parameters you want (e.g. DLSS strength, how much to upscale, shader parameters) in any step of the process
  - Change the pipeline in any way while looking at the game window, live, for the change in effects, without having to go out of the game or restart
  - And this applies for all games! Whatever macOS `.app`, something running on CrossOver, a browser game, Android/iOS, visual novels, whatever you want!

A lot of these graphics features are custom ports to macOS that are again found nowhere else and are unique to MacLauncher. For example:
- Lossless Scaling macOS port
- ReShade macOS port
- Various AMD FSR things

# MacLauncher as a tinker tool

I guess the main "philosophy" of MacLauncher is that these are _your_ games, locally, and the job of MacLauncher is to help you do whatever you want with them, i.e. to give the user maximum control over everything possible. As such, the whole model is that MacLauncher uses local files, downloads what you want via version managers, and offers very fine-grained settings. Some things I want to highlight:
- There are very granular settings for most runtimes and game types. I generally like passing all parameters in so you can set whatever launch flags you want, basically, anything the runtime (or graphics or whatever) allows, you can set. You can also set custom launch flags. Or for example, every game lets you disable network access.
- Whenever possible, for everything (runtimes, games, graphics, accounts, whatever), I try to make the version management as robust as possible. Any downloadable runtime versions can be selected and used, you can manage multiple google accounts for google play or steam accounts for steam integration or whatever, we try to detect what runtime version a game uses as much as possible, etc etc. In short, you can always control exactly what version of everything you use, which is important for compatibility (but we also try to make the defaults as seamless as possible).
- There is a huge host of "tools"—stuff like decompilers/asset viewers, save editors, cheats (especially for RPGMaker and Ren'Py games where a universal cheat is possible)—for as many game types as we could find them for. Most runtimes will have some type of extraction available, once again see [MODULES.md](docs/MODULES.md) for details.
- There is also a very convenient storefront integration. Currently, we support Steam, GOG, Epic, Itch.io, Google Play, and F-Droid/IzzyOnDroid, and you are able to download any games you own (or are free) from MacLauncher itself. The special part about this feature is that, as much as possible, we allow you to download whatever version of games you want. For example, the Steam launcher might not allow you to download Windows versions of a game on mac, but MacLauncher lets you download whatever you want, including Windows, or Linux, or mac 32-bit, or any previous version of the game if you have the depot ID (e.g. through SteamDB). Or for example, you can sign in to however many accounts you want and are not restricted to one account.
- MacLauncher will never have user-hostile anti-features, or violate privacy. Every single network call is from a specific user interaction (e.g. refreshing upstream versions of stuff), without any background network calls or network call from navigating to some tab.

# Development

MacLauncher is built on Electron. Yes I know, Electron bad, Electron waste RAM in RAM crisis, Electron = npm supply chain attacks and left pad and react bloat, etc. Believe it or not, however, Electron was actually a conscious decision for this project for the following reasons (possibly cope):
- So browser-based games (a significant chunk of games) can play without external runtime downloads.
- Because I might want to port this to Linux or Android (maybe even parts to iOS) in the future and some sort of a shared codebase would be nice.
- Because the launcher actually doesn't matter that much for performance: after importing games, you don't actually need to use the Electron launcher at all, you can just save the game config as a `.command` and open it without going through Electron UI at all.

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

MacLauncher is **alpha software!** Things might be unstable or stupid...

# Docs

- [User guide](docs/README.md)
- [Runtime guides](docs/runtimes/README.md)
- [Tools and saves](docs/README.md#saves-cheats-and-source-tools)
- [Attributions](docs/ATTRIBUTIONS.md)
- [Backend and CLI](docs/BACKEND.md)
- [Development and app builds](docs/DEVELOPMENT.md)
- [Repository guide](docs/REPO_GUIDE.md)

# License

See [attributions](docs/ATTRIBUTIONS.md) for what existing projects I used and the licenses they have (mostly open source stuff). MacLauncher itself is [MIT licensed](LICENSE), just maybe because claiming what is mostly LLM code (with zero human expertise coming from me, a zero-expertise human) as in any way "my intellectual property" is facetious.