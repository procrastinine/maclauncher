---
title: Any window or display
description: "Apply MacLauncher's shaders, upscalers, neural models and frame generation to any app's window, in place or scaled to fill the screen, or to an entire display on macOS 15.2 or later."
head:
  - tag: title
    content: "Shaders, upscaling and frame generation for any app's window on Mac | MacLauncher"
sidebar:
  order: 8
---

MacLauncher can apply its graphics chain, with shaders, upscaling, neural models and frame generation, to the window of any app on your Mac or to an entire display. The app doesn't have to be in your library, so games from other launchers, emulators and ports get the same effects as the games MacLauncher plays itself. Window graphics need macOS 15.2 or later and MacLauncher's graphics components; without them, the window graphics menu items and shortcut don't appear.

## Starting

**File → Apply Graphics To** lists the apps that are running, the most recently used first, with **Entire Display** at the bottom. MacLauncher's Dock menu has the same list. Choosing an app opens the macOS window picker, filtered to that app's windows, and choosing **Entire Display** opens it for a display instead.

A window needs no extra permission, because picking it in the macOS window picker counts as your consent. Entire Display also has to leave MacLauncher's own output out of the picture, so macOS asks for the Screen & System Audio Recording permission the first time you use it.

A shortcut can skip the menu. Assign **Start or stop window graphics** in [Settings → Launcher](/maclauncher/graphics/composing-effects/#shortcuts-and-screenshots), and it starts a session for the app in front, or stops that app's session when you press it again.

## While it runs

Once you pick a window, the app appears in the library as a temporary row with a **Stop** button. Selecting it opens the usual **Graphics** tab in the inspector, with rows, presets, live edits and status, just as for a game. The processed picture appears in a separate window above the app's window, either [in place or scaled to fill the screen](#in-place-or-scaled-to-screen). It hides while the window is minimized or on another Space, and comes back with it.

Turning **Graphics** off stops the capture and hides the processed picture, and turning it back on resumes without asking you to pick the window again. The session ends and its row disappears when the window closes, the app quits, you stop sharing from the macOS capture indicator, you choose **Stop**, or MacLauncher quits. If the app opens a new window within 10 seconds of closing the picked one, the picker opens once more so you can pick the new window. The Dock menu lists running sessions under **Stop Window Graphics**.

## In place or scaled to screen

The **Output** setting of the **Window capture** runtime places the processed picture. Entire Display sessions are always in place.

**In place**, the default, lays the processed picture exactly over the window. Clicks, keys and controllers pass straight through to the app. The picture follows the window when it moves, resizes or goes full screen, and hides while another app's window covers it.

**Scaled to screen** enlarges the window's picture to fill the screen it's on, keeping the window's shape, with black bars on the remaining sides. The menu bar and the Dock stay visible unless the window is full screen. The chain's scaling method does the enlarging, so a [spatial upscaler](/maclauncher/graphics/upscaling/) such as FSR 1 or MetalFX Spatial can turn a small window into a full-screen picture, much as [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) does on Windows. The picture shows while that app is in front, and it steps aside when you switch to another app or when one of the app's own windows, such as a dialog, covers the picked window.

Clicks, drags, scrolls and pointer movement on the scaled picture go to the matching spot in the window, clicks on the black bars do nothing, and keys and controllers go to the app as usual. An app that reads the pointer's screen position directly, rather than from these events, sees the pointer where it really is on the screen. Sending pointer events to another app needs MacLauncher to have the Accessibility permission. Choosing **Scaled to screen** without it brings up the macOS request and keeps **In place**; once you've allowed it in **System Settings → Privacy & Security → Accessibility**, choosing **Scaled to screen** again applies it.

## Effects on a window

The picture comes from Apple's [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), which delivers the window's finished image at its own pixel size. Color effects, shaders, scaling methods, neural image processing and image-pair frame generation apply to it. Options that need data from inside a game's renderer, such as its render resolution, depth and motion vectors, aren't offered.

- **Include pointer in capture**, a setting of the **Window capture** runtime, draws the pointer into the captured image, so effects apply to it as well. The real pointer always stays on top.
- The output's [frame-rate cap](/maclauncher/graphics/composing-effects/#frame-rate-cap) limits how often MacLauncher takes a frame from the window, which leaves GPU time for heavy effects.

## Remembered chains

Each app keeps its own chain. When a session ends, MacLauncher saves its chain and capture settings for that app, and the next session for the same app starts from them. Entire Display has a chain of its own. An empty chain with no saved capture settings is left out. The store holds at most 50 chains, including Entire Display, drops the least recently used one first, and forgets apps that are no longer installed.

## Games that block the graphics library

A few games carry a code signature that doesn't let MacLauncher's graphics library load into them. When such a game in your library has a graphics chain, MacLauncher starts it with its original rendering and applies the chain to a captured copy of its window instead, the same way as above. The picker opens for the game's first window and accepts only a window that belongs to the game. The game's own row keeps its chain, live edits and status, and cancelling the picker leaves the game's original rendering. This also needs macOS 15.2 or later.

The reference describes [window entries](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOW.md), including sessions, remembered chains and [games that block the graphics library](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOW.md#games-that-block-the-graphics-library), in full, and the frame source reference covers the [capture path](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#picked-windows-and-displays) and the [capture companion](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#capture-companion).
