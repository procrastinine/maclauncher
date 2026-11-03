# Window

Window graphics apply a graphics chain to windows of other running apps and to displays. Each chosen window, app or display starts a session with its own library entry, which is not imported: the entry appears when the session starts and disappears when it ends. Every entry has its own graphics chain, capture settings, inspector and **Stop**, so each window or display can carry different effects. All Displays is one entry whose chain applies to every display. While it runs, an entry works like any other game in the inspector, with the same Graphics tab, live edits, presets and status.

## Requirements

Window graphics need macOS 15.2 or later and a graphics runtime that includes the window graphics helper. When either is missing, the window graphics menu items, Dock menu items and shortcuts are not shown. [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md) lists the platform minimum.

Window previews, display sessions and choosing a window directly need the Screen & System Audio Recording permission for MacLauncher, because macOS shows other apps' window contents only with that permission. Without it, an app's windows are chosen in the macOS window picker, which needs no permission.

## Starting a session

**File → Apply Graphics…** and **Apply Graphics…** in the MacLauncher Dock menu open the Apply Graphics window. It is a separate window; choosing the menu item again brings the open one forward.

- **Displays** lists each display by its macOS name, such as Built-in Retina Display, with a live preview and its size in points. With more than one display, **All Displays** is listed after them; choosing it starts one entry that captures every display, each with its own output and the entry's chain.
- **Windows** lists the windows of the apps that appear in the Dock, grouped by app with the app's icon, with apps and windows in their front-to-back order on screen. Each window shows its title and a preview. Full-screen windows are listed, and so are windows on other Spaces and minimized windows that have a title, marked **Other Space or minimized**. Without a search, the list shows at most 96 windows; with more open, each app's front window is kept before the others. The search also finds the other windows, up to 2,048 more, each listed with its app and shown with the app's icon in place of a preview.
- A preview appears as soon as its window or display is listed. Previews of visible windows and displays then refresh every few seconds while the window is open, and a window on another Space or minimized keeps its first preview. The search field filters displays, apps and windows by name, title or detail, such as a display's size or **Other Space or minimized**.
- A window, display or All Displays that already has an entry shows **Has window graphics** in its detail. So does a window of an app whose entry was started for the whole app, a display while All Displays runs, and All Displays while any single display has an entry. Choosing such a tile starts nothing, and the library reports "*Name* could not start. *Name* already has window graphics. Its library entry controls them."
- Choosing any other tile starts a new session at once, with its own entry. The arrow keys move between tiles, Return or Space chooses the selected one, Command-F or / selects the search field and Escape clears the search or closes the window.
- The list and its previews come from MacLauncher's capture service, the process that also captures for running entries, so opening the window starts no second capture process.

The first time the window opens, macOS asks for the Screen & System Audio Recording permission. Until it is granted, the window lists the running apps without previews, and Displays stays empty. Choosing an app then opens the macOS window picker in single-window mode for that app's windows. The picker excludes MacLauncher and other apps by their bundle identifiers; a process without a bundle identifier can still appear, and selecting its window makes the session follow that process. **Open Privacy Settings** opens the permission's page in System Settings, and the window shows previews and lists displays the next time it becomes active after the permission is granted. When the permission is removed while the window is open, or macOS refuses a capture for lack of it, the window shows the same notice and app list.

The graphics shortcut **Toggle Graphics for Front App**, assigned in Settings, starts a session for the frontmost app. With the Screen & System Audio Recording permission, the session takes the app's front window directly: its frontmost on-screen window at the ordinary window level that measures at least 64 by 64 points. Without the permission, or without such a window, the macOS window picker opens for that app's windows. Pressed while the frontmost app's windows have graphics, the shortcut ends those entries instead.

Once a window or display is chosen, the entry shows **Stop**, and the library selects it, scrolls to it and opens its inspector. A session entry leads the library in every sort order, after favorites in the custom order. A session that starts without any effects leaves its target unchanged: the library window comes forward with the entry's **Graphics** section open, and the entry notes that effects added there apply while it runs. Cancelling the macOS window picker ends the session without leaving an entry.

## One entry per window or display

Each window, app and display that receives graphics has its own entry, with its own chain, capture settings, output and saved chain. An edit in one entry's **Graphics** section changes only that entry's window or display. A window, app or display belongs to at most one entry at a time. Two windows of one app are two entries; [Saved chains](#saved-chains) describes how they share the app's saved chain.

The inspector's **Applied to** section names what an entry applies to: a window by its title with its app, an app whose window is still to be picked in the macOS window picker, or a display by name. The row's remove button ends the entry. While a running window has shown no image for 2 seconds, the row's detail reads "Waiting for the window's first image" until the first image arrives. The detail also gives the reason when the output cannot be shown on a full-screen Space and when a capture fails.

All Displays is one entry with one chain and an output on each display. Its **Applied to** section lists every display with its own remove button, and removing the last display ends the entry.

The File and Dock menus list running entries under **Stop Window Graphics**, one item per entry, by name, which ends it. All Displays with several displays appears as one **Remove** item per display, followed by **Stop**, which ends the entry. The submenu ends with **Toggle Graphics for Front App** and **Toggle pointer in window graphics**, with native accelerator labels for assigned shortcuts. Assigned items are disabled references to the global shortcuts, which act on the frontmost app when pressed. An unassigned item opens the Launcher section of Settings. Each app-window entry also has a pointer command labeled with that entry's name; it acts on that entry without a front-app lookup. The inspector shows both actions in **Keyboard shortcut** rows above Applied to, with the assigned keys or **Assign in Settings…**. Help buttons explain each action there and in Settings.

## Output

The processed image appears in a separate window over the captured window or display. Placing it never raises or activates an app, and clicks, scrolls and keys always pass through it to the apps beneath. The **Output** capture setting places it **In place**, as **Fit screen**, or enlarged by **1.5×**, **2×**, **2.5×**, **3×**, **4×**, **5×**, **6×**, **8×** or **10×**. Display entries are always in place and cover their display.

In every placement, the output appears over full-screen apps and in every Space where the window is visible. It hides while the window is minimized, hidden or on a Space that is not shown, while Mission Control is open, and while the Mac sleeps, locks or switches users. Capture continues while the window is out of view, except during sleep, a lock or a user switch, so the output is current when the window returns. A session for a window on another Space starts without output, which appears when that Space is shown. When the window is on screen but its output cannot join the active Space, as on some full-screen Spaces, the output hides after 0.3 seconds and the entry gives the reason "The output cannot be shown on this full-screen Space". The output's presentation follows the refresh of the display that holds the largest part of the window, and it presents nothing while hidden.

Turning graphics off in the inspector stops that entry's capture and hides its output; the macOS capture indicator disappears once no entry captures. Turning graphics back on resumes the capture without asking for the window again.

### In place

The processed image covers the captured window exactly. It follows the window when it moves, resizes or enters full screen, and it moves with the window on every display refresh while the window is dragged. The window's child windows, such as sheets and panels attached to the window, appear in the processed image, and so do the app's own floating palettes and panels that overlap the window. When the window resizes, or a child window appears, moves or closes, the output keeps its last processed image until the capture shows the new arrangement, so the unprocessed window does not show in between.

The effect stacks with the window: other windows that cover the window cover the effect, and clicks and selection inside the window leave it in front. While nothing covers the window, the output stays one level above ordinary windows, so a click that brings the window forward leaves the output above it. When another window comes over the window, the output drops to the window's level directly above it, and it returns to the front when the window does. The output stays on while another app is active. Menus, the menu bar, the Dock and alerts stay in front of it, and the outputs of other entries never count as windows that cover the window. A display entry's output stays one level above ordinary windows.

### Fit screen and scale factors

**Fit screen** fills the screen that holds the window, at the window's aspect ratio, with black bars on the remaining sides. It covers the screen except the menu bar and the Dock, or the whole screen when the window fills it, as a native full-screen window does. A scale factor enlarges the window about its center by that factor, reduced where needed to fit the screen's visible frame, moved inside it and aligned to whole points. The chain's scaling method enlarges the image, so spatial upscaling applies to the window as it does to a game's output. When the window resizes or moves to another display, the image follows its new size, aspect ratio and screen.

A scaled output stays one level above ordinary windows while it runs, including while another app is active, and the window itself stays in place beneath it. Pointer input goes to the window:

- While the scaled output shows and the window's app is active, MacLauncher keeps the pointer inside the window and hides the system pointer, so clicks, drags and scrolls reach the window directly.
- The processed image shows a drawn pointer at the matching point of the enlarged image. The **Show pointer in picture** setting turns it off. The graphics shortcut **Toggle pointer in window graphics**, assigned in Settings, turns it off or on in the frontmost app's entries while they run, without changing the setting.
- When an app holds the pointer still and reads only its movement, as games with mouse look do, the drawn pointer hides until the pointer moves again.
- When another app becomes active, the pointer moves freely and the system pointer returns.
- Keys and game controllers go to the active app as usual.

Keeping the pointer inside the window needs the Accessibility permission for MacLauncher. Choosing **Fit screen** or a scale factor without it shows the macOS request and keeps **In place**. Once the permission is granted in System Settings > Privacy & Security > Accessibility, a later choice of a scaled output takes effect. A session that starts with a scaled output after the permission was removed stays in place and logs the reason.

## Graphics

The capture supplies the window's finished image at the window's own pixel size. Color effects, scaling methods and image-pair frame generation apply through the same graphics chain as for games. Options that need the renderer's own resolution control or scene data, such as source resolution, depth and motion vectors, are not offered; the window module declares no source-resolution control, so the Graphics section also leaves out GPU downsampling of the captured image. A window entry's frame-generation rows start with **Keep static content** on, as [Static content](../graphics/PROVIDERS.md#static-content) describes; a saved row keeps its own value. The inspector of a session entry holds only **Stop**, **Keyboard shortcut**, **Applied to** and **Graphics**, because the entry has no files, launch settings, tools or notes of its own. [Frame sources and runtime adapters](../graphics/INPUTS_AND_ADAPTERS.md#picked-windows-and-displays) describes the capture path.

The output's **Frame-rate cap** limits how often frames are taken from the window, as [Source frame-rate cap](../graphics/FRAME_API.md#source-frame-rate-cap) describes for game frame sources.

### Capture settings

The **Window capture** runtime has three settings. A change to any of them applies to the running entry.

| Setting | Default | Effect |
| --- | --- | --- |
| Output | In place | **In place** covers the window; **Fit screen** fills the window's screen; **1.5×** to **10×** enlarge the window about its center. A scaled output keeps the pointer inside the window, as [Output](#output) describes. Display entries ignore it. |
| Include pointer in capture | Off | Draws the pointer into the captured image, so effects apply to it. In place, the system pointer always appears above the output. |
| Show pointer in picture | On | Shows a drawn pointer in a scaled output's image. |

## Ending a session

A window's session ends, and its entry disappears, when the window closes, its app quits or its row is removed; a display's session ends when the display is disconnected or removed. Any session also ends when sharing is stopped from the macOS capture indicator, when **Stop** is chosen in the library, the inspector, the File menu or the Dock menu, and when MacLauncher quits. All Displays ends when its last display leaves, and it adds a display that is connected while it runs. Ending a session stops only that entry's process; the captured windows and their apps keep running unchanged, and so do the other entries. Removing every effect keeps the session running with its target unchanged.

One capture service process makes every capture for MacLauncher. It starts with the first entry or when the Apply Graphics window opens, serves every entry and the window's list, and exits 2 seconds after the last of them ends, once its captures have stopped. It also exits when MacLauncher quits. When the service exits or stops responding for 5 seconds, each entry hides its output, which leaves the original window visible, then starts a new service and opens its capture again. A second loss within 10 seconds ends the entries with the reason "Window capture stopped unexpectedly".

A capture that cannot start, or that stops with an error, ends its session, or removes that display from All Displays, and MacLauncher shows the reason; other entries keep running. When the Screen & System Audio Recording permission is missing or removed, this happens at once. A capture that macOS interrupts restarts at once, at most once in 10 seconds; any other capture failure ends the session after 5 seconds, which leaves time for a resized window to settle and capture again.

MacLauncher treats a window as closed when macOS no longer lists it. Some apps keep a closed window to show it again later; such a window counts as hidden until the app shows it again or quits.

When a captured window closes while its app keeps running and the app opens a new window within 10 seconds, the session continues with it. For a window chosen in the Apply Graphics window, the session moves to the app's new window directly; for a window picked in the macOS window picker, the picker opens once more, and cancelling it ends the session. Without a new window, the session ends.

## Saved chains

Each app and each display keeps its graphics chain between sessions. A session starts from the saved chain of its window's app or of its display. When it ends, its plan and capture settings are saved for the app or display it served:

- For a window, the chain is saved for the app that owns the window, identified by its bundle identifier, or by its executable path and name when it has no bundle. When a window picked in the macOS window picker belongs to a process other than the chosen app, such as a game started by a launcher app, the chain is saved for the process that owns the window.
- For a display, the chain is saved for that display, identified by the display's stable macOS identifier, or by its name when macOS reports none.
- All Displays has one chain of its own. The displays it covers, including one connected while it runs, are saved under All Displays rather than as single displays.
- An app whose window was never picked in the macOS window picker has served nothing, so its saved chain stays unchanged.

Entries for two windows of one app each start from the app's saved chain, and the entry that ends last leaves its chain saved for the app. The next session for the same app or display starts from that chain; one without a chain starts from an empty chain.

The chains live in `graphics/application-stacks.json` in the application data directory and stay bounded:

- An empty chain without saved capture settings is not stored, and saving one removes the saved chain of that app or display.
- At most 50 chains are kept, including display chains; the least recently used is removed first.
- A chain is at most 64 KiB and the file at most 2 MiB.
- Apps that are no longer installed are removed once per MacLauncher start, through an offline check.

## Storage

A session's entry has its own folder under `games/`, which holds its record, prepared plan and live controls. The folder is deleted when the session ends, together with the entry's rows in the prepared-plan index `graphics/live-prepared-rows.json`. Folders left by an interrupted MacLauncher process, and their rows, are deleted at the next start. Captured frames stay in GPU memory; session events go to the main log, the capture service writes no log, and no per-session log or recording file is written. Previews in the Apply Graphics window are held in memory while it is open and are never written to disk.

Library rows for window sessions show their target titles and display names in place of the temporary session folder.
