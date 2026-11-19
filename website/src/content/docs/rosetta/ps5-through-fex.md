---
title: PS5 games through FEX
description: How AnyPS5 runs the original x86-64 game code in an Apple Silicon host.
---

PS5 games use the same x86-64 instruction family as Intel PCs, but they ask for PS5 system services. AnyPS5 supplies those services through its own libraries. In the FEX build, the host and those libraries run directly on Apple Silicon while FEX translates the game's original instructions. The host loads the game's executable and modules as PS5 programs, and an Apple Silicon Vulkan driver brings the graphics to Metal.

The FEX build is a MacLauncher Builds download under **PS5 (AnyPS5)** in Runtimes. The published **MCLv13** FEX build requires macOS 27.0 because that is the minimum built into its launcher. The converted-game route is still available and uses Rosetta on Apple Silicon. Both routes use the same library entry, controls and save folder. [AnyPS5 FEX release](https://github.com/procrastinine/maclauncher-builds/releases/tag/anyps5-fex/vMCLv13/arm64), [PlayStation 5 reference](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md#anyps5)
