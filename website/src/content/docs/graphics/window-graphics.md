---
title: Any window or display
description: "Apply MacLauncher's shaders, upscalers, neural models and frame generation to any app's window, in place, enlarged or scaled to fill the screen, or to one display or all of them, each with its own chain, on macOS 15.2 or later."
head:
  - tag: title
    content: "Shaders, upscaling and frame generation for any app's window on Mac | MacLauncher"
sidebar:
  order: 8
---

MacLauncher can apply its graphics chain, with shaders, upscaling, neural models and frame generation, to the windows of any apps on your Mac and to your displays, several of them at once, and each window or display gets its own chain. The app doesn't have to be in your library, so games from other launchers, emulators and ports get the same effects as the games MacLauncher plays itself. Window graphics need macOS 15.2 or later and MacLauncher's graphics components; without them, the window graphics menu items and shortcut don't appear.

## Starting

**File → Apply Graphics…**, or **Apply Graphics…** in MacLauncher's Dock menu, opens the Apply Graphics window, which shows a live preview of everything you can choose:

- **Displays** shows each display under its macOS name, such as Built-in Retina Display or your monitor's name. With more than one display, **All Displays** applies one chain to every display at once.
- **Windows** shows the windows of your apps, grouped by app with the app's icon. Full-screen windows are there too, and so are windows on other Spaces and minimized windows, marked **Other Space or minimized**.

The previews of visible windows refresh every few seconds, and the search field finds an app or a window by name. The list shows up to 96 windows, keeping each app's front window, and the search finds the rest too, so a window doesn't go missing when you have a lot open. Click a tile, or move to it with the arrow keys and press Return, and the session starts right away, with its own row in the library. A window or display that already has graphics is marked **Has window graphics**; its row in the library is where you change or stop them.

macOS only lets an app see other apps' windows with the Screen & System Audio Recording permission, so it asks for that permission the first time the window opens. If you don't allow it, the window lists your running apps without previews, and choosing one opens the macOS window picker for that app's windows; picking a window there counts as your consent, so no permission is needed that way. Displays, though, always need it. **Open Privacy Settings** takes you to the right page in System Settings, and the previews appear the next time you come back to the window after allowing it.

A shortcut can skip the window. Assign **Toggle graphics for front app** in [Settings → Launcher](/maclauncher/graphics/composing-effects/#shortcuts-and-screenshots), and it starts a session for the app in front, taking its front window right away when MacLauncher has the Screen & System Audio Recording permission, or through the macOS window picker when it doesn't. Pressing it again while that app is in front ends its graphics.

## While it runs

Once you choose a window or display, it appears in the library as a temporary row with a **Stop** button, at the top of the list, and the library selects it. If the app or display has no saved chain yet, nothing changes on screen until you add effects, so MacLauncher comes forward with the row's **Graphics** section open. Selecting the row opens the usual **Graphics** tab in the inspector, with rows, presets, live edits and status, just as for a game. The processed picture appears in a separate window above the app's window, either [in place, enlarged or scaled to fill the screen](#in-place-enlarged-or-fit-screen). It also appears over full-screen apps. It hides while the window is minimized or on a Space you aren't looking at, and comes back when the window does, so a window chosen on another Space shows its effects once you switch to that Space.

Several windows and displays can have graphics at once, each in its own row with its own chain, so a game can wear a CRT shader while a video player next to it gets an upscaler. Editing one row changes only its window. All Displays is the exception: it's one row whose chain covers every display, and its inspector lists the displays under **Applied to**, where the button beside each one takes it back out. The Dock and File menus list every row under **Stop Window Graphics**, and the end of that menu shows the shortcut, or offers to assign one in Settings.

Turning **Graphics** off stops the capture and hides the processed picture, and turning it back on resumes without asking you to choose again. A session ends and its row disappears when its window closes or its app quits, when you disconnect its display, when you stop sharing from the macOS capture indicator, when you choose **Stop**, or when MacLauncher quits; the other rows keep running. If an app opens a new window within 10 seconds of closing a captured one, the new window takes its place. All Displays picks up a display you connect while it runs. If capturing fails, for example because MacLauncher lost the Screen & System Audio Recording permission, that session ends and MacLauncher tells you why.

## In place, enlarged or fit screen

The **Output** setting of the **Window capture** runtime places the processed picture: **In place**, **Fit screen**, or enlarged by **1.5×** up to **10×**. Display sessions are always in place.

**In place**, the default, lays the processed picture exactly over the window. Clicks, keys and controllers pass straight through to the app. The picture follows the window when it moves, resizes or goes full screen, and keeps up with a window you drag, frame by frame. Sheets and other windows attached to the window appear in the processed picture, and so do the app's own floating palettes when they overlap it. The effect stacks with the window, as if it were part of it: another window that covers the window covers the effect too, and when you bring the window back, the effect comes with it. Clicks and selection inside the window leave the effect in front. The effect stays on while you work in another app. MacLauncher never brings a window forward or moves focus to show the effect. Menus, the Dock and alerts still appear over it.

**Fit screen** enlarges the window's picture to fill the screen it's on, keeping the window's shape, with black bars on the remaining sides. The menu bar and the Dock stay visible unless the window is full screen. A scale factor such as **2×** or **3×** enlarges the picture around the window's center instead, as far as the screen allows. The chain's scaling method does the enlarging, so a [spatial upscaler](/maclauncher/graphics/upscaling/) such as FSR 1 or MetalFX Spatial can turn a small window into a full-screen picture, much as [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) does on Windows. The enlarged picture stays up while you use other apps, and clicks always pass through it.

While the enlarged picture shows and its app is in front, MacLauncher keeps the mouse pointer inside the real window underneath, hides the system pointer and draws a pointer on the enlarged picture at the matching spot. Clicks, drags and scrolls land in the window exactly where the drawn pointer points, and keys and controllers go to the app as usual. **Show pointer in picture**, another **Window capture** setting, hides the drawn pointer, and the **Toggle pointer in window graphics** shortcut in Settings turns it off and on for the app in front while you play. A game that holds the pointer still for mouse look hides the drawn pointer until the pointer moves again. Switch to another app and the pointer is free again. Keeping the pointer inside the window needs MacLauncher to have the Accessibility permission. Choosing **Fit screen** or a scale factor without it brings up the macOS request and keeps **In place**; once you've allowed it in **System Settings → Privacy & Security → Accessibility**, choosing it again applies it.

## Effects on a window

The picture comes from Apple's [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), which delivers the window's finished image at its own pixel size. Color effects, shaders, scaling methods, neural image processing and image-pair frame generation apply to it. Options that need data from inside a game's renderer, such as its render resolution, depth and motion vectors, aren't offered.

- **Include pointer in capture**, a setting of the **Window capture** runtime, draws the pointer into the captured image, so effects apply to it as well. The real pointer always stays on top.
- The output's [frame-rate cap](/maclauncher/graphics/composing-effects/#frame-rate-cap) limits how often MacLauncher takes a frame from the window, which leaves GPU time for heavy effects.

## Remembered chains

Each app and each display keeps its own chain, and All Displays has one more. When a session ends, MacLauncher saves its chain and capture settings for its app or display (the displays under All Displays are saved as All Displays), and the next session for that app or display starts from it. Two windows of the same app each start from the app's chain, and the one that ends last is the one remembered. A display is recognized by the identifier macOS gives it, so a monitor keeps its chain when you plug it back in. An empty chain with no saved capture settings is left out. MacLauncher keeps at most 50 chains, drops the least recently used one first, and forgets apps that are no longer installed.

The reference describes [window entries](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOW.md), including sessions and remembered chains, in full. The frame source reference covers the [capture path](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#picked-windows-and-displays).
