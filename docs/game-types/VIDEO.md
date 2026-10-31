# Video

This game type covers local video files. MacLauncher plays them through [mpv](https://mpv.io/), with the same shaders, scaling, neural reconstruction and ordered effect chains that games use.

## Accepted inputs

Import accepts MP4, M4V, QuickTime, Matroska, WebM, AVI, FLV, MPEG program streams and Ogg Theora. It reads local container and video-track metadata without starting a player.

### Playlists

A folder with top-level videos and no top-level executable imports as one playlist when game detection finds no game in it. Videos are sorted alphabetically by file name, and videos in subfolders are left out. The inspector's **Video** menu selects a starting video or **Automatic**, which resumes the last unfinished video or starts the next one after a video is finished. After the final video finishes, Automatic returns to the first. Playback continues through the rest of the playlist, with previous and next controls in mpv. Watch positions are stored in the library's per-entry data.

### Subtitles

Embedded subtitles and matching separate subtitle files register automatically. Separate subtitle files can sit next to the video or in a `subs`, `subtitles`, `Subs` or `Subtitles` folder, and their file names can carry language suffixes, as in `Episode 01.en.srt`. Subtitles are selected in the player.

## Playback

mpv keeps its seeking, pause, volume, resizing and fullscreen controls. The initial window fits within 80% of the screen without locking its size. Local playback uses the selected mpv configuration and plugins, with embedded file references and network media resolution disabled by default. Custom launch arguments are passed literally before the video-file argument and apply from the next playback.

## Player configuration and plugins

**Settings → Video**, under the mpv player heading, holds the playback defaults, and each video's mpv settings can override them.

**uosc controls** and **Timeline previews** are on by default. [uosc](https://github.com/tomasklaen/uosc) provides the timeline and playback controls, and [thumbfast](https://github.com/po5/thumbfast) generates preview images while the pointer hovers over that timeline. Plugins install only through explicit Install, Download or Update actions. A missing plugin never blocks Play or asks for a download; playback then uses mpv's standard on-screen controls, which also remain available when uosc is disabled.

Upstream mpv and the [decoded GPU builds](#output-paths) load the same player configuration, scripts and plugin settings. Decoded GPU playback runs thumbfast's image-encoding worker in a separate mpv command-line player, and previews stay off when no compatible worker is installed.

### Managing plugins

**Runtimes → mpv player → Plugins** shows each plugin's enable switch, installation status, Install or Repair action, removal control and source link together. A missing or damaged installation disables the plugin's enable switch until installation or repair completes. A successful removal disables the plugin, and a canceled removal keeps the setting.

**Add plugin** accepts a GitHub repository or file link, a Lua or JavaScript script or ZIP URL, or a local script, ZIP or plugin folder. **Script location** sets an optional relative entry path for packages with a different layout. Added plugins appear next to uosc and thumbfast with enable and removal controls. MacLauncher keeps its own copy of each added plugin and leaves the original local files unchanged. Adding an updated source creates a separate version identified by its content, and GitHub repository imports record the resolved commit.

### Plugin updates

uosc and thumbfast versions come from their upstream projects. **Refresh** lists the recent stable uosc releases and the current thumbfast commit, and shows when a newer version than the installed one is available. **Install** uses the newest listed version. When no list has been fetched yet, the same Install action fetches it first and then continues with the installation. Installed versions stay usable without a network connection; status checks, playback and removal make no network requests.

- A uosc version is a stable release that publishes a uosc ZIP and configuration file, `uosc.zip` and `uosc.conf` or renamed files with the same extensions. Each of the two downloads must match the size GitHub reports for it and, when the release publishes one, its SHA-256 digest. The license notice comes from the repository at the release's tagged commit, found through GitHub's license lookup when it is not named `LICENSE`. The release's `ziggy` helper must be a macOS executable with an Apple Silicon or Intel slice that links only system libraries.
- thumbfast publishes no releases, so a thumbfast version is a snapshot of the newest commit of its default branch, labeled by commit date, such as **2026-06-28 snapshot**. The script and its license download from addresses fixed to that commit.

Each installation records the SHA-256 hash of every download and installed file. Status checks and playback compare the installed files with that record, and a changed or incomplete installation shows **Repair**.

**Update** on uosc or thumbfast fetches the current list and installs the newest version, which replaces the earlier installation once it passes verification. An earlier copy that a running playback still uses stays installed until the next update, and the next Play uses the newest installation. On added plugins, **Update** checks the plugin's saved source and installs from it. Added plugins keep their original URL, branch or local path and optional entry script, and an explicit commit or release URL keeps that version fixed.

**Runtimes → mpv player → uosc helper** lists native MacLauncher Builds packages alongside upstream helpers. Automatic selection prefers a build for the launcher’s CPU; saved versions and alternate CPU choices use the shared runtime controls. Installing uosc acquires an available native helper in the same operation, copies it and its notices into the new plugin, and records those files in the plugin receipt. An unavailable optional package keeps the publisher’s helper, which uses Rosetta when it is Intel-only on Apple Silicon. Existing plugin installations retain their files and work offline.

A plugin that is already current reports **Up to date**. A failed update leaves the installed copy and its settings in place, and disabled plugins stay disabled. Earlier copies of an added plugin remain installed; enabling an earlier copy selects it in place of another version from the same source. Updates apply on the next Play.

### Configuration files and scripts

**Configuration and scripts** expands the local file and folder controls:

- **Configuration folder** points to an existing mpv configuration directory with `mpv.conf`, `input.conf`, `scripts`, `script-opts`, fonts and other mpv resources.
- **Additional configuration files** load further files in the listed order.
- **Additional scripts** loads Lua or JavaScript files and mpv script folders.
- **Input configuration** selects a separate file for keyboard and mouse bindings.

Browse and Add controls select local files and folders, and typed lists take one absolute path per line. Selected files stay in their original locations. Configuration and plugin changes apply on the next playback. The [mpv manual](https://mpv.io/manual/stable/#files) describes configuration entries, script options and resource paths.

## Filters and effects

New videos use **Lanczos · Sharp** scaling. The graphics chain has independent Downsample and Upscale stages, each with filter and output-size controls. Turning Graphics off preserves the chain and falls back to basic bilinear resizing. The native filter list comes from the installed player and updates during playback through its live connection, while the player version and decoder stay fixed for that session.

### Output paths

MacLauncher uses two kinds of mpv build, with different output paths:

- **Decoded GPU** builds render at the decoder's dimensions into IOSurfaces shared with Metal. The common graphics graph receives those textures before window fitting, and image filters, downsampling, neural reconstruction, upscaling and interpolation run in their saved order. Pixel processing stays on the GPU. Paused redraws are marked as the same decoded content and do not submit interpolation history.
- **Original mpv CLI** builds keep their native output path. Shared effects receive the composed RGB drawable through native Metal or OpenGL hooks after mpv's output scaling.

Decoded GPU builds with separate overlay support render mpv's controls, subtitles and plugin overlays at the window's backing resolution. A transparent native layer presents them after the video effect chain, so ASS output from uosc, bitmap previews from thumbfast and other mpv overlays keep their original colors and sharpness regardless of the video's resolution and effects.

The runtime's Source detail shows the route in use. A window graphics host does not by itself turn on ScreenCaptureKit streaming. The [frame-source reference](../graphics/PIPELINE.md#frame-sources-and-scene-inputs) describes the source routes and separate scene inputs.

### mpv shaders

MPV/libplacebo shaders can use the source, luma, chroma and scaling phases of mpv's native pipeline. A compatible leading run of these shaders, the mpv prefix, runs there with the original decoder planes. Later luma and chroma shaders stay at their position in the shared chain and use GPU-derived planes when the selected graphics runtime supports them. Native decoder metadata is available only to the prefix. Native filters run once, independently of the shared ReShade, Slang, neural and scaling stages.

### Live changes

Shader selection, parameters, order and shared effects update during playback. Replacement resources are prepared before the switch, and a rejected edit keeps the current chain. Updates preserve the playback position, pause state, window and fullscreen state. Changes to shared effects alone redraw a paused image without seeking. Combined native and shared changes use a coordinated display hold; transitions outside that hold's presentation mode apply separately or on the next playback. Graphics bypass leaves the saved effects intact, and clearing the chain is a separate action.

**Manage filters…** opens the shader library in Runtimes → Graphics. Local and downloaded shaders use the same selectors. Original files stay in place, and prepared revisions pick up source edits without reusing old compiled contents.

### Neural reconstruction

Shared neural reconstruction works on the supplied RGB image, and its model and processing stages are independent of native decoder filtering. Downsample, the model's intrinsic scale and Upscale each have their own dimensions. The [graphics guide](../graphics/README.md) covers models, shader parameters, chain ordering and processing sizes.

## Preview and export

**Tools → Video processing** provides **Inspect media**, **Preview settings** and **Export video…**. Preview and export use the saved graphics chain, including applied presets. For a playlist, inspection and export use the video selected in the inspector's Video menu, including Automatic's current choice, while Preview opens the whole playlist.

**Inspect media** writes container, duration, stream and codec, chapter and tag metadata to `modules/video/inspection/media.json`. It reuses the selected mpv with an explicit private script and null audio and video outputs. User mpv configuration, automatic scripts, network references and download integrations are disabled.

**Preview settings** plays the video through mpv with its native shader phases, the shared effects and the usual playback controls.

**Export video…** renders image filters, resizing and compatible neural stages into a separate MP4 file. A size dialog offers Original, 2× and 4K before the save dialog, and an enabled upscale stage preselects 2×. The output dimensions determine automatic fitting and window-relative row sizes. Relative factors, fixed sizes and stage order mean the same regardless of the playback window.

### Export formats and limits

Export follows the selected helper's macOS requirement, listed in [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics), and accepts opaque sources that AVFoundation can decode and that contain one video track. SDR output uses H.264. Tagged PQ and HLG sources use floating-point GPU processing and hardware HEVC Main10 encoding with their output color tags. The MP4 includes AAC audio, source timestamps, and rotation and mirror metadata. Existing output files are not overwritten. Progress includes Cancel, and completion offers **Reveal in Finder**.

ReShadeFX, Slang, mpv/libplacebo, Downsample, Upscale and neural rows run in their saved order. Export starts from decoded RGB and uses the derived-plane adapter for luma and chroma hooks. Inputs that only the native decoder provides require the mpv prefix. Scene temporal upscaling needs renderer guides that the export decoder does not supply. Source videos with alpha use Preview instead.

Frame-generation export needs an offline runtime that advertises paired-frame output for the selected method. Compatible image-pair methods insert generated frames between source timestamps. During warmup and unavailable phases, a completed real image is held, and held frames are counted separately from generated ones.

Neural export uses the selected model, intensity and temporal reconstruction option. **Runtimes → Graphics → Neural models** manages model packages, and model choosers can also import local apps or ZIPs. The optional DLSSMac model download imports only packages and notices and never runs its app. Model weights keep their original terms.

## Runtimes

### mpv player

**Runtimes → mpv player** has two sources, Builds and Upstream, and can also import a local mpv.

Upstream Refresh includes numbered releases and the development builds from [git-release](https://github.com/mpv-player/mpv/releases/tag/git-release). A development version records its exact source commit and build identifier, and an installed version stays fixed when the development release updates.

Upstream downloads include Apple Silicon and Intel builds. The publisher names each Mac build after its minimum macOS version and CPU, as in `mpv-v0.41.0-macos-14-arm.zip` and `mpv-v0.41.0-macos-15-intel.zip`, and the catalog lists the build with the lowest minimum for this Mac's CPU. A universal download serves both CPUs, and the player application is found wherever the ZIP or tar archive places it. Downloads are checked as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity), and installation verifies the archive and native dependencies. The Builds source supplies an adapted mpv host for decoded GPU frames, which requires Apple Silicon and macOS 27 or later. Graphics providers keep their own requirements, which [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) lists.

mpv is distributed separately. Its [installation reference](https://mpv.io/installation/) and [release catalog](https://github.com/mpv-player/mpv/releases) describe upstream builds and licenses.
