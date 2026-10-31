# Window

Window graphics apply a graphics chain to a window of another running app, or to an entire display. Each use is a session, which is not imported: its library entry appears when the session starts and disappears when it ends. While it runs, the entry works like any other game in the inspector, with the same Graphics tab, live edits, presets and status.

## Requirements

Window graphics need macOS 15.2 or later and a graphics runtime that includes the window graphics helper. On a Mac without either, the window graphics menu items, Dock menu items and shortcut are not shown. [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md) lists the platform minimum.

## Starting a session

**File → Apply Graphics To** and the MacLauncher Dock menu list the running apps that appear in the Dock, most recently active first, and **Entire Display** below a separator. The list comes from local process information and is rebuilt when a MacLauncher window becomes active.

- Choosing an app opens the macOS content picker in single-window mode. The picker excludes MacLauncher and other apps by their bundle identifiers. A process without a bundle identifier can still appear; selecting its window makes the session follow that process. The picker serves as consent, so a window needs no Screen Recording permission.
- Choosing **Entire Display** opens the picker in single-display mode. Leaving the session's own output out of the capture needs the Screen & System Audio Recording permission, which macOS asks for the first time Entire Display is used.
- The graphics shortcut **Start or stop window graphics**, assigned in Settings, starts a session for the frontmost app without the menu, or stops that app's session.

Once a window or display is chosen, the entry shows **Stop**. Cancelling the picker ends the session without leaving an entry.

## Output

The processed image appears in a separate window above the picked window. The **Output** capture setting places it **In place** or **Scaled to screen**. Display sessions are always in place and cover the whole display.

In both placements, the output joins full-screen Spaces and hides while the window is minimized, hidden or on another Space, and while the Mac sleeps, locks or switches users; it returns with the window. Turning graphics off in the inspector stops the capture and hides the output; the macOS capture indicator disappears with it. Turning graphics back on resumes the capture without asking for the window again.

### In place

The processed image covers the picked window exactly. The output ignores the pointer, so clicks, keys and controllers reach the app directly. It follows the window when it moves, resizes or enters full screen, and hides while another app's window covers the picked window.

### Scaled to screen

The processed image fills the screen that holds the window, at the window's aspect ratio, with black bars on the remaining sides. It covers the screen except the menu bar and the Dock, or the whole screen when the window fills it, as a native full-screen window does. The chain's scaling method enlarges the image, so spatial upscaling applies to the window as it does to a game's output. When the window resizes or moves to another display, the image follows its new aspect ratio and screen.

The output shows while the window's app is the active app. It hides when another app becomes active and while one of the app's own windows, such as a dialog, covers the picked window, so that window stays usable.

Pointer input on the image goes to the window:

- A click, drag, scroll or pointer movement on the image is sent to the matching point of the window. The bars ignore the pointer, and a drag that leaves the image ends at its edge.
- Keys and game controllers go to the app, which stays active while the output is clicked.
- The forwarded events carry the matching window position. An app that reads the system pointer position directly, instead of from its events, sees the pointer's position on the screen.

Sending pointer events to another app needs the Accessibility permission for MacLauncher. Choosing **Scaled to screen** without it shows the macOS request and keeps **In place**. Once the permission is granted in System Settings > Privacy & Security > Accessibility, a later choice of **Scaled to screen** takes effect. A session that starts with Scaled to screen after the permission was removed stays in place and logs the reason.

## Graphics

The capture supplies the window's finished image at the window's own pixel size. Color effects, scaling methods and image-pair frame generation apply. Options that need the renderer's own resolution control or scene data, such as source resolution, depth and motion vectors, are not offered. [Frame sources and runtime adapters](../graphics/INPUTS_AND_ADAPTERS.md#picked-windows-and-displays) describes the capture path.

The output's **Frame-rate cap** limits how often frames are taken from the window, as [Source frame-rate cap](../graphics/FRAME_API.md#source-frame-rate-cap) describes for game frame sources.

### Capture settings

The **Window capture** runtime has two settings. A change to either applies to a running session.

| Setting | Default | Effect |
| --- | --- | --- |
| Output | In place | **In place** covers the window; **Scaled to screen** fills the window's screen and forwards the pointer, as [Output](#output) describes. Display sessions ignore it. |
| Include pointer in capture | Off | Draws the pointer into the captured image, so effects apply to it. The system pointer always appears above the output. |

## Ending a session

The session ends, and its entry disappears, when the window closes, the app quits, sharing is stopped from the macOS capture indicator, **Stop** is chosen in the library or inspector, the shortcut is pressed again for that app, or MacLauncher quits. The Dock menu lists running sessions under **Stop Window Graphics**.

MacLauncher treats a window as closed when macOS no longer lists it. Some apps keep a closed window to show it again later; such a window counts as hidden until the app shows it again or quits.

When a picked window closes while its app keeps running, the picker opens once more if the app opens a new window within 10 seconds. Choosing a window there starts a new session; cancelling the picker, or waiting, ends it.

## Saved chains

Each app keeps its graphics chain between sessions. When a session ends, its plan and capture settings are saved for the app, identified by its bundle identifier, or by its executable path and name when it has no bundle. When the picked window belongs to a process other than the chosen app, such as a game started by a launcher app, the chain is saved for the process that owns the window. Entire Display has one chain of its own. The next session for the same app starts from that chain; an app without one starts from an empty chain.

The chains live in `graphics/application-stacks.json` in the application data directory and stay bounded:

- An empty chain without saved capture settings is not stored, and saving one removes the app's entry.
- At most 50 chains are kept, including the Entire Display chain; the least recently used is removed first.
- A chain is at most 64 KiB and the file at most 2 MiB.
- Apps that are no longer installed are removed once per MacLauncher start, through an offline check.

## Storage

A session's entry has its own folder under `games/`, which holds its record, prepared plan and live controls. The folder is deleted when the session ends, together with the entry's rows in the prepared-plan index `graphics/live-prepared-rows.json`. Folders left by an interrupted MacLauncher process, and their rows, are deleted at the next start. Captured frames stay in GPU memory; session events go to the main log, and no per-session log or recording file is written.

## Games that block the graphics library

A library game whose code signature does not allow the graphics library to load starts with its original rendering. When its plan needs processing and window graphics are available, the window graphics helper runs beside the game and processes a copy of its window. It waits for the game's first window, opens the picker for it and accepts only a window that belongs to the game's process. The game's own entry keeps its plan, live edits and status, and the inspector shows that graphics process a captured copy of the window. The helper stops when the game ends. Cancelling the picker keeps the original rendering.
