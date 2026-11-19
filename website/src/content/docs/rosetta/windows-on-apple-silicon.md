---
title: Windows games on Apple Silicon
description: How Apple Silicon builds of Wine run Windows games with FEX in MacLauncher.
---

A Windows game asks for Windows services, even when it runs on a Mac. Wine answers those requests. When Wine itself is built for Apple Silicon, it can talk to macOS directly. Its FEX translator runs the game's Intel instructions inside that native Wine process. This is how an x86 Windows game can run without asking Rosetta to translate Wine.

MacLauncher offers **MetalSharp Wine** as a download from its publisher. It can also use a **CrossOver** installation with ARM64 Wine, including the builds from CodeWeavers' ARM64 preview. **Highball Wine** uses the signed loader in your installed Highball app. All three appear under **Wine · Apple Silicon** when their native Wine builds are available to MacLauncher. [MetalSharp Wine releases](https://github.com/metalsharp/MetalSharp-Wine/releases), [CrossOver ARM64 preview](https://www.codeweavers.com/blog/mjohnson/2026/7/31/crossover-preview-the-right-to-bear-arm64-on-mac), [Highball Wine releases](https://github.com/gauthierpiarrette/highball-engine/releases)

Graphics have their own part in this. The game still speaks Direct3D, while the graphics translator and driver get its pictures onto the screen. A Mac graphics library loaded by native Wine needs an Apple Silicon build of its own. [MacLauncher's Apple Silicon builds](/maclauncher/rosetta/apple-silicon-builds/)
