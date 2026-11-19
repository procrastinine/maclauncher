---
title: MacLauncher’s Apple Silicon builds
description: Native graphics, Steam and game engine builds for Apple Silicon Macs.
---

FEX can translate a guest game's instructions, but the Mac libraries next to it need to match the host. **MacLauncher DXMT** is one example. It gives MetalSharp Wine a native Metal renderer and Windows libraries in ARM64X format. That format lets compatible Wine builds load ARM code even when the game itself is x86-64. There are Apple Silicon builds of MacLauncher's Vulkan drivers and the WineVulkan scene helper too. [Graphics translators](/maclauncher/windows/graphics-translators/), [MacLauncher Builds packages](https://procrastinine.github.io/maclauncher-builds/)

The **Steam client bridge** ships an Apple Silicon library for native Wine. It connects a Windows game's Steam calls to the Steam client for Mac. **DXVK-NVAPI** illustrates a different boundary. Its upstream Windows release includes ARM64X DLLs, while MacLauncher's Vulkan DLSS forwarding loads the upstream x64 Windows DLL. Those Windows DLLs come from DXVK-NVAPI's publisher. [Steam client bridge](/maclauncher/windows/steam-client-bridge/), [DXVK-NVAPI release](https://github.com/jp7677/dxvk-nvapi/releases/tag/v0.9.3)

Native builds help outside Wine as well. MacLauncher Builds publishes Apple Silicon or Universal packages for game engines such as GemRB, MKXP-Z, RLVM and LÖVE 0.10.2. Its Universal Steamworks bridge gives compatible Java games an Apple Silicon library to use with a native Java. A Universal package supplies code for both Mac processors, so an Apple Silicon Mac can take its native slice. [Processor compatibility](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/PROCESSOR_COMPATIBILITY.md)
