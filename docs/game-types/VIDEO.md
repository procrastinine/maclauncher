# Video

This game type covers local video files. MacLauncher plays them through [mpv](https://mpv.io/), with the same shaders, scaling, neural reconstruction and ordered effect chains that games use.

## Accepted inputs

Import accepts MP4, M4V, QuickTime, Matroska, WebM, AVI, FLV, MPEG program streams and Ogg Theora. While importing, MacLauncher reads local container and video-track metadata without starting a player.

### Playlists

A folder of videos can be imported as one playlist. This happens when the folder has top-level videos and no top-level executable, and game detection finds no game in it. The videos are sorted alphabetically by file name, and videos in subfolders are left out.

Where playback starts is chosen in the inspector's **Video** menu: either a particular video or **Automatic**, which resumes the last unfinished video or, once a video is finished, starts the next one. After the final video finishes, Automatic returns to the first. From the starting video, playback continues through the rest of the playlist, and mpv has previous and next controls. Watch positions are stored in the library's per-entry data.

### Subtitles

Both embedded subtitles and matching separate subtitle files register automatically. A separate subtitle file can sit next to the video or in a `subs`, `subtitles`, `Subs` or `Subtitles` folder, and its file name can carry a language suffix, as in `Episode 01.en.srt`. Once registered, subtitles are selected in the player.

## Playback

Local playback runs mpv with the selected configuration and plugins, and mpv keeps its seeking, pause, volume, resizing and fullscreen controls. Embedded file references and network media resolution, however, are disabled by default. The initial window fits within 80% of the screen without locking its size. Custom launch arguments are passed literally before the video-file argument and apply from the next playback.

## Player configuration and plugins

Playback stages writable configuration in an owned temporary session folder, named `maclauncher-mpv-<process ID>-<session ID>`. Original configuration files, scripts and fonts remain in their original locations. Preparation failures and player exit remove the folder; unused preparation is also removed when its launcher worker exits. A marker records the player process once it starts. After a forced termination, the next playback reclaims abandoned folders, including the generated folders from earlier releases, while preserving folders owned by live players. Recent preparations retain a one-minute handoff interval before reclamation. A player that outlives the launcher keeps its folder while it runs; a later playback reclaims it after that player exits.

Playback defaults are set in **Settings → Video**, under the mpv player heading, and each video's mpv settings can override them.

Two plugins are on by default. [uosc](https://github.com/tomasklaen/uosc), under **uosc controls**, provides the timeline and playback controls, and [thumbfast](https://github.com/po5/thumbfast), under **Timeline previews**, generates preview images while the pointer hovers over that timeline. When an enabled plugin is missing, Play offers it as an optional download and continues preparing playback once it is installed, while **Skip** plays without that plugin. Without uosc, playback uses mpv's standard on-screen controls, which also remain available when uosc is disabled. Plugins can also be installed and updated with the Install, Download and Update actions.

Both upstream mpv and the [decoded GPU builds](#output-paths) load the same player configuration, scripts and plugin settings. For decoded GPU playback, thumbfast's image-encoding worker runs in a separate mpv command-line player, and previews stay off when no compatible worker is installed.

### Managing plugins

Plugins are downloaded and removed in **Runtimes → mpv player → Plugins**, which shows each plugin's installation status, version, Install, Repair or Update action, removal control and source link together. The switches that turn plugins on or off are settings, so they are in **Settings → Video** with the other mpv settings: **uosc controls** and **Timeline previews**, and under **Added plugins** one **Use <name>** switch for each added plugin. An added plugin's switch is disabled while its installation is missing or damaged. Installing a plugin turns it on, a successful removal turns it off, and a canceled removal keeps the setting.

Other plugins can be added with **Add plugin**, which accepts a GitHub repository or file link, a Lua or JavaScript script or ZIP URL, or a local script, ZIP or plugin folder. For packages with a different layout, **Script location** sets an optional relative entry path. Added plugins then appear next to uosc and thumbfast with their removal controls. MacLauncher keeps its own copy of each one and leaves the original local files unchanged. Adding an updated source creates a separate version identified by its content, and a GitHub repository import also records the resolved commit.

### Plugin updates

uosc and thumbfast versions come from their upstream projects. **Refresh** lists the recent stable uosc releases and the current thumbfast commit and shows when a version newer than the installed one is available. **Install** uses the newest listed version; if no list has been fetched yet, the same action fetches it first and then continues with the installation. Once installed, a version stays usable without a network connection, because status checks, playback with installed plugins and removal make no network requests.

- A uosc version is a stable release that publishes a uosc ZIP and configuration file, `uosc.zip` and `uosc.conf` or renamed files with the same extensions. Each of the two downloads must match the size GitHub reports for it and, when the release publishes one, its SHA-256 digest. When the repository has a license notice at the release's tagged commit, the installation includes it, and a notice not named `LICENSE` is found through GitHub's license lookup. The release's `ziggy` helper, in turn, must be a macOS executable with an Apple Silicon or Intel slice that links only system libraries.
- thumbfast publishes no releases, so a thumbfast version is a snapshot of the newest commit of its default branch, labeled by commit date, such as **2026-06-28 snapshot**. The script and its license download from addresses fixed to that commit.

Each installation records the SHA-256 hash of every download and installed file. Status checks and playback then compare the installed files with that record, and a changed or incomplete installation shows **Repair**.

For uosc or thumbfast, **Update** fetches the current list and installs the newest version, which replaces the earlier installation once it passes verification. If a running playback still uses the earlier copy, that copy stays installed until the next update, while the next Play uses the newest installation. Added plugins are updated from their own source instead. Each keeps its original URL, branch or local path and optional entry script, and **Update** checks that saved source and installs from it. An explicit commit or release URL keeps that version fixed.

The uosc helper has its own list, **Runtimes → mpv player → uosc helper**, where native MacLauncher Builds packages appear alongside upstream helpers. Automatic selection prefers a build for the launcher’s CPU, and saved versions and alternate CPU choices use the shared runtime controls. When uosc is installed, an available native helper is acquired in the same operation, copied with its notices into the new plugin and recorded in the plugin receipt. If that optional package is unavailable, the plugin keeps the publisher’s helper, which uses Rosetta when it is Intel-only on Apple Silicon. Existing plugin installations retain their files and work offline.

When a plugin is already current, it reports **Up to date**. A failed update leaves the installed copy and its settings in place, and disabled plugins stay disabled. Earlier copies of an added plugin also remain installed, and enabling one of them selects it in place of another version from the same source. Updates apply on the next Play.

### Configuration files and scripts

Existing mpv configuration and scripts can be used as well, with these fields of the mpv settings in **Settings → Video** and in each video's mpv settings:

- **Configuration folder** points to an existing mpv configuration directory with `mpv.conf`, `input.conf`, `scripts`, `script-opts`, fonts and other mpv resources.
- **Additional configuration files** load further files in the listed order.
- **Additional scripts** loads Lua or JavaScript files and mpv script folders from where they are. Unlike a plugin added in **Runtimes → mpv player → Plugins**, which MacLauncher copies, verifies and updates, these files are read in place and can differ for each video.
- **Input configuration** selects a separate file for keyboard and mouse bindings.

Local files and folders can be selected with the Browse and Add controls or typed into a list, one absolute path per line, and selected files stay in their original locations. Configuration and plugin changes apply on the next playback. Configuration entries, script options and resource paths are described in the [mpv manual](https://mpv.io/manual/stable/#files).

## Filters and effects

New videos use **Lanczos · Sharp** scaling. The graphics chain has independent Downsample and Upscale stages, each with filter and output-size controls. Turning Graphics off preserves the chain and falls back to basic bilinear resizing. The native filter list comes from the installed player and updates during playback through its live connection, while the player version and decoder stay fixed for that session.

Because video playback supplies images only, methods that need matching renderer depth, motion or camera data are not offered. These are scene-temporal upscaling and the scene variants of MetalFX, FSR 3 and XeSS frame generation. Temporal methods that use only image history, such as MLX, are still available, and so is image-pair frame generation, such as MetalFX image interpolation. When a saved row holds a scene method, it reads **Inactive** with the reason and offers a method of the same kind that works with video.

Frame generation uses the content timestamps of decoded images when they carry them. It then fills the full interval between successive images, including at low frame rates and in slowed playback. Image processing follows these media timestamps, whereas the playback speed is set by the player's presentation deadlines. Interpolated playback also keeps one decoded interval of lookahead. File export uses the same generation timeline and writes the generated in-between images at their media timestamps.

### Output paths

MacLauncher uses two kinds of mpv build, with different output paths:

- **Decoded GPU** builds render at the decoder's dimensions into IOSurfaces shared with Metal. Those textures reach the common graphics graph before window fitting, where image filters, downsampling, neural reconstruction, upscaling and interpolation run in their saved order, and pixel processing stays on the GPU. Paused redraws are marked as the same decoded content and do not submit interpolation history.
- **Original mpv CLI** builds keep their native output path. Here, shared effects receive the composed RGB drawable through native Metal or OpenGL hooks after mpv's output scaling.

When a decoded GPU build has separate overlay support, it renders mpv's controls, subtitles and plugin overlays at the window's backing resolution. A transparent native layer presents them after the video effect chain, so ASS output from uosc, bitmap previews from thumbfast and other mpv overlays keep their original colors and sharpness regardless of the video's resolution and effects.

Which route is in use appears in the runtime's Source detail. A window graphics host does not by itself turn on ScreenCaptureKit streaming. The source routes and separate scene inputs are described in the [frame-source reference](../graphics/PIPELINE.md#frame-sources-and-scene-inputs).

### mpv shaders

MPV/libplacebo shaders can use the source, luma, chroma and scaling phases of mpv's native pipeline. A compatible leading run of these shaders, the mpv prefix, runs there with the original decoder planes. Later luma and chroma shaders, by contrast, stay at their position in the shared chain and use GPU-derived planes when the selected graphics runtime supports them. Only the prefix has access to native decoder metadata. Native filters run once, independently of the shared ReShade, Slang, neural and scaling stages.

### Live changes

Changes to shader selection, parameters, order and shared effects apply during playback. Replacement resources are prepared before the switch, and if an edit is rejected, the current chain stays. These updates preserve the playback position, pause state, window and fullscreen state, and a change to shared effects alone redraws a paused image without seeking. Combined native and shared changes use a coordinated display hold, whereas transitions outside that hold's presentation mode apply separately or on the next playback. Graphics bypass leaves the saved effects intact; clearing the chain is a separate action.

The shaders themselves are kept in the shader library in Settings → Graphics, which **Manage filters…** opens. Local and downloaded shaders use the same selectors. Original files stay in place, and prepared revisions pick up source edits without reusing old compiled contents.

### Neural reconstruction

Shared neural reconstruction works on the supplied RGB image, and its model and processing stages are independent of native decoder filtering. Downsample, the model's intrinsic scale and Upscale each have their own dimensions. Models, shader parameters, chain ordering and processing sizes are covered in the [graphics guide](../graphics/README.md).

## Preview and export

Videos can be inspected, previewed and exported from **Tools → Video processing**, which provides **Inspect media**, **Preview settings** and **Export video…**. Preview and export both use the saved graphics chain, including applied presets. For a playlist, inspection and export use the video selected in the inspector's Video menu, including Automatic's current choice, while Preview opens the whole playlist.

**Inspect media** writes container, duration, stream and codec, chapter and tag metadata to `modules/video/inspection/media.json`. To do so, it reuses the selected mpv with an explicit private script and null audio and video outputs, and with user mpv configuration, automatic scripts, network references and download integrations disabled.

**Preview settings** plays the video through mpv with its native shader phases, the shared effects and the usual playback controls.

**Export video…** renders image filters, resizing and compatible neural stages into a separate MP4 file. Before the save dialog, a size dialog offers Original, 2× and 4K, with 2× preselected when an upscale stage is enabled. In the export, the output dimensions determine automatic fitting and window-relative row sizes, whereas relative factors, fixed sizes and stage order mean the same regardless of the playback window.

### Export formats and limits

Export follows the selected helper's macOS requirement, listed in [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics), and accepts opaque sources that AVFoundation can decode and that contain one video track. The encoding depends on the source: SDR output uses H.264, while tagged PQ and HLG sources use floating-point GPU processing and hardware HEVC Main10 encoding with their output color tags. Besides the video, the MP4 includes AAC audio, source timestamps, and rotation and mirror metadata. Existing output files are not overwritten. While an export runs, its progress includes Cancel, and on completion it offers **Reveal in Finder**.

In an export, ReShadeFX, Slang, mpv/libplacebo, Downsample, Upscale and neural rows run in their saved order. Processing starts from decoded RGB and uses the derived-plane adapter for luma and chroma hooks, although inputs that only the native decoder provides still require the mpv prefix. Scene temporal upscaling needs renderer guides that the export decoder does not supply. Source videos with alpha use Preview instead.

To export frame generation, the selected method needs an offline runtime that advertises paired-frame output for it. Compatible image-pair methods then insert generated frames between source timestamps. During warmup and unavailable phases, a completed real image is held instead, and held frames are counted separately from generated ones.

Neural export uses the selected model, intensity and temporal reconstruction option. Model packages are managed in **Runtimes → Effects → Neural models**, and model choosers can also import local apps or ZIPs. The optional DLSSMac model download imports only packages and notices and never runs its app. Model weights keep their original terms.

## Runtimes

### mpv player

**Runtimes → mpv player** has two sources, Builds and Upstream, and can also import a local mpv.

For the Upstream source, Refresh lists numbered releases as well as the development builds from [git-release](https://github.com/mpv-player/mpv/releases/tag/git-release). A development version records its exact source commit and build identifier, and an installed version stays fixed when the development release updates.

Upstream downloads include Apple Silicon and Intel builds. The publisher names each Mac build after its minimum macOS version and CPU, as in `mpv-v0.41.0-macos-14-arm.zip` and `mpv-v0.41.0-macos-15-intel.zip`, and the catalog lists the build with the lowest minimum for this Mac's CPU. A universal download serves both CPUs. Downloads are checked as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity), and installation finds the player application wherever the ZIP or tar archive places it and verifies the archive and native dependencies.

The Builds source, by contrast, supplies an adapted mpv host for decoded GPU frames, which requires Apple Silicon and macOS 27 or later. Graphics providers keep their own requirements, which [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) lists.

mpv is distributed separately. Its [installation reference](https://mpv.io/installation/) and [release catalog](https://github.com/mpv-player/mpv/releases) describe upstream builds and licenses.
