---
title: Any window or display
description: "Apply MacLauncher's shaders, upscalers, neural models and frame generation to any app's window, in place, enlarged or scaled to fill the screen, or to one display or all of them, each with its own chain, on macOS 15.2 or later."
head:
  - tag: title
    content: "Shaders, upscaling and frame generation for any app's window on Mac | MacLauncher"
sidebar:
  order: 8
---

Besides the games it plays itself, MacLauncher can apply its graphics chain, with shaders, upscaling, neural models and frame generation, to the window of any app on your Mac or to your displays. The app doesn't have to be in your library, so games from other launchers, emulators and ports can get the same effects. Several windows and displays can have graphics at once, and each one gets its own chain.

This feature, window graphics, needs macOS 15.2 or later and MacLauncher's graphics components. Without them, its menu items and shortcut don't appear.

## Starting

To pick a window or display, choose **File → Apply Graphics…**, or **Apply Graphics…** in MacLauncher's Dock menu. The Apply Graphics window shows a live preview of everything you can choose:

- **Displays** shows each display under its macOS name, such as Built-in Retina Display or your monitor's name. With more than one display, there is also **All Displays**, which applies one chain to every display at once.
- **Windows** shows the windows of your apps, grouped by app with the app's icon. Full-screen windows are listed too, and so are windows on other Spaces and minimized windows, which are marked **Other Space or minimized**.

Previews of visible windows refresh every few seconds. The list shows up to 96 windows and always keeps each app's front window. The search field finds an app or a window by name, including windows beyond that limit, so a window doesn't go missing when you have a lot open. Clicking a tile, or moving to it with the arrow keys and pressing Return, starts a window graphics session right away, and the session gets its own row in the library. A window or display that already has graphics is marked **Has window graphics**, and its row in the library is where you change or stop them.

macOS lets an app see other apps' windows only with the Screen & System Audio Recording permission, so it asks for that permission the first time the Apply Graphics window opens. If you don't allow it, the window lists your running apps without previews. Choosing one of them then opens the macOS window picker for that app's windows, and since picking a window there counts as your consent, this route works without the permission. Displays, however, always need it. **Open Privacy Settings** takes you to the right page in System Settings, and once you've allowed the permission, the previews appear the next time you come back to the Apply Graphics window.

A keyboard shortcut can also skip the Apply Graphics window. Once **Toggle graphics for front app** is assigned in [Settings → Launcher](/maclauncher/graphics/composing-effects/#shortcuts-and-screenshots), pressing it starts a session for the app in front. With the Screen & System Audio Recording permission, the session takes that app's front window right away; without it, the macOS window picker opens instead. Pressing the shortcut again while that app is in front ends its graphics.

## While it runs

The window or display you choose appears at the top of the library as a temporary row with a **Stop** button, and the library selects it. If the app or display has no saved chain yet, nothing changes on screen until you add effects, so MacLauncher comes forward with the row's **Graphics** section open. Selecting the row opens the usual **Graphics** tab in the inspector, with rows, presets, live edits and status, just as for a game.

The processed picture is shown in a separate window above the app's window, [in place, enlarged or scaled to fill the screen](#in-place-enlarged-or-fit-screen), and it also appears over full-screen apps. While the window is minimized or on a Space you aren't looking at, the picture is hidden, and it comes back when the window does. A window chosen on another Space therefore shows its effects once you switch to that Space.

Because every window and display has its own row and chain, a game can wear a CRT shader while a video player next to it gets an upscaler, and editing one row changes only its window. All Displays is the exception: it is one row whose chain covers every display. Its inspector lists those displays under **Applied to**, and the button beside each one takes that display back out. The Dock and File menus list every row under **Stop Window Graphics**, and the end of that menu shows the window graphics shortcuts or offers to assign them in Settings.

Turning **Graphics** off stops capturing and hides the processed picture. Turning it back on resumes without asking you to choose again.

A session ends, and its row disappears, when its window closes or its app quits, when you disconnect its display, when you stop sharing from the macOS capture indicator, when you choose **Stop**, or when MacLauncher quits. The other rows keep running. If an app opens a new window within 10 seconds of closing a captured one, though, the new window takes its place, and All Displays picks up a display you connect while it runs. When capturing fails, for example because MacLauncher lost the Screen & System Audio Recording permission, that session ends and MacLauncher tells you why.

## In place, enlarged or fit screen

Where the processed picture goes is set by **Output**, a setting of the **Window capture** runtime that window rows use. It can be **In place**, **Fit screen**, or enlarged by **1.5×** up to **10×**. Display sessions are always in place.

**In place**, the default, lays the processed picture exactly over the window, and clicks, keys and controllers pass straight through to the app. The picture follows the window when it moves, resizes or goes full screen, keeping up frame by frame while you drag it. Sheets and other windows attached to the window are part of the processed picture, and so are the app's own floating palettes where they overlap it.

The effect is also stacked with the window, as if it were part of it. Another window that covers the window covers the effect too, and when you bring the window back, the effect comes with it. Clicks and selection inside the window leave the effect in front. It stays on while you work in another app, and MacLauncher never brings a window forward or moves focus to show it. Menus, the Dock and alerts still appear over it.

**Fit screen** enlarges the window's picture to fill the screen it's on. The window's shape is kept, with black bars on the remaining sides, and the menu bar and the Dock stay visible unless the window is full screen. A scale factor such as **2×** or **3×** instead enlarges the picture around the window's center, as far as the screen allows. The enlarging itself is done by the chain's scaling method, so a [spatial upscaler](/maclauncher/graphics/upscaling/) such as FSR 1 or MetalFX Spatial can turn a small window into a full-screen picture, much as [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) does on Windows. The enlarged picture stays up while you use other apps, and clicks always pass through it.

An enlarged picture no longer lines up with the real window underneath, so MacLauncher takes care of the pointer while the picture shows and its app is in front. It keeps the mouse pointer inside the real window, hides the system pointer and draws a pointer on the enlarged picture at the matching spot. As a result, clicks, drags and scrolls land in the window exactly where the drawn pointer points, and keys and controllers go to the app as usual. When you switch to another app, the pointer is free again.

The drawn pointer can be hidden with **Show pointer in picture**, another **Window capture** setting, or, while you play, turned off and on for the app in front with the **Toggle pointer in window graphics** shortcut in Settings. A game that holds the pointer still for mouse look also hides the drawn pointer until the pointer moves again.

Keeping the pointer inside the window needs the Accessibility permission. If MacLauncher doesn't have it, choosing **Fit screen** or a scale factor brings up the macOS request and keeps **In place**; once you've allowed it in **System Settings → Privacy & Security → Accessibility**, choosing the setting again applies it.

## Effects on a window

MacLauncher gets the window's picture from Apple's [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), which delivers the finished image at the window's own pixel size. Color effects, shaders, scaling methods, neural image processing and image-pair frame generation all work on that image. Options that need data from inside a game's renderer, such as its render resolution, depth and motion vectors, aren't offered, however.

Two more settings apply to a captured window:

- **Include pointer in capture**, a setting of the **Window capture** runtime, draws the pointer into the captured image, so effects apply to it as well. The real pointer always stays on top.
- The output's [frame-rate cap](/maclauncher/graphics/composing-effects/#frame-rate-cap) limits how often MacLauncher takes a frame from the window, which leaves GPU time for heavy effects.

## Remembered chains

When a session ends, MacLauncher saves its chain and capture settings for its app or display, and the next session for that app or display starts from them. Each app and each display therefore keeps its own chain, and All Displays has one more, under which an All Displays session is saved. Two windows of the same app each start from the app's chain, and whichever ends last is the one remembered. Displays are recognized by the identifier macOS gives them, so a monitor keeps its chain when you plug it back in.

An empty chain with no saved capture settings isn't saved. MacLauncher keeps at most 50 chains, dropping the least recently used one first, and it forgets apps that are no longer installed.

MacLauncher's reference documentation describes [window entries](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOW.md) in full, including sessions and remembered chains, and the frame source reference explains [how windows and displays are captured](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#picked-windows-and-displays).
