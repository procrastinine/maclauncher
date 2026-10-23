# Shared graphics processing

Per-game shaders and filters use the same configuration across supported runtimes.
The shared preset list accepts ReShade `.fx` effects, RetroArch Slang `.slangp`
presets, individual `.slang` shaders and MPV/libplacebo `.glsl` or `.hook`
shaders. ReShadeFX processes `.fx` files; librashader provides the Metal pipeline
for Slang presets and their passes, and libplacebo processes MPV shaders.
Shared game hooks accept RGB frames. Native video playback also supplies the
original luma and chroma planes through mpv; those video-only choices are omitted
from game selectors. The [video reference](VIDEO.md) describes native scaling,
shader routing and next-launch bindings.
Format recognition and provider availability are separate: imported files remain
listed when a provider is unavailable, with its architecture, macOS or build
requirement shown. The [pipeline reference](../GRAPHICS_PIPELINE.md) describes
runtime adapters, programmatic controls and frame-input ownership.
Metal and hardware OpenGL presentation adapters connect the game's graphics API
to the effect processor. Runtime names do not identify graphics APIs: Chromium,
Wine, Java and native applications can use different rendering paths.

Games that change their own rendering resolution continue to fill the output
window with ordinary filtering when optional upscaling is off. Selecting an
upscaler changes that filtering; it is not required for a game's built-in dynamic
resolution.

## Simple and advanced effects

The inspector starts with simple per-game shader, scaling and frame-generation
controls. **Advanced…** opens an ordered video-effects list derived from those
settings. Opening the list and reading shader parameters do not change the saved
configuration. The first edit saves an advanced plan, which remains selected
when the inspector reopens.

Appearance and restoration filters stay in **Shaders and filters**. Shaders
that declare image upscaling appear under **Spatial upscaling**, alongside the
other spatial methods and **Custom shader…**. They share render or processing
resolution controls and retain their own parameters. Intrinsic shader sizes
are preserved, with final fitting afterward. Selecting a shader does not by
itself lower game rendering resolution or enable virtual presentation.

Simple **Neural reconstruction** offers **DLSS 5 · Experimental** through the
MLX-DLSS provider, including compatible DLSSMac model packages. Enabling it
reuses a compatible local model or offers model preparation with download
consent; cancellation preserves the current settings. Game processing starts
at **Auto**, adapting to the physical window size and source aspect ratio. The
shorter fitted output edge divided by 540 selects a rounded reduction divisor
from 1× to 4×: 2× at 1920 × 1080, 3× at 2560 × 1440 and 4× at 3840 × 2160.
Smaller inputs retain their size;
native videos start without an additional reduction. Native window processing
reduces the completed frame once before reconstruction and retains the engine's
3D rendering scale; this does not reduce the game's 3D render cost. Explicit
producers may lower full-frame allocation through their declared contract.
Simple hides Render resolution while neural reconstruction manages sizing.
The chosen spatial filter fits the result to
presentation; **Automatic fit** selects an available MetalFX, bicubic or bilinear
filter after reconstruction. This automatic sizing belongs to Simple. Conversion to Advanced
shows explicit window-relative reduction, neural and final-fit rows, while an existing Advanced plan keeps
its manually selected sizes. Processing sizes and compatible managed model
selections update during play on supported shared presentation paths.

Neural reconstruction, the spatial filter, frame generation and shaders use
independent controls. MetalFX and FSR 1 remain available after enabling neural
reconstruction. LSFG's frame-rate selector includes 4×; its quality, precision
and pacing settings are under **Frame generation options**. The first Simple
neural setup suggests LSFG 4× where available; later choices remain editable.
Pending model preparation shows a status message without disabling the other
graphics controls. Turning neural reconstruction off cancels its pending
preparation; separately started downloads remain available in Runtimes.
Selecting LS1 or
LSFG reuses models compatible with all selected processing options or offers
model preparation. A canceled preparation leaves the selection unchanged.

**Add effect…** offers shaders, spatial scaling, temporal upscaling,
neural reconstruction and frame generation. Search matches their names, categories and requirements. Unavailable
choices display the missing runtime support, graphics inputs or models. Temporal
methods require compatible data from the actual game's renderer; a final color
image alone does not supply motion vectors, depth or jitter.

Video effects run from top to bottom. Each row retains its own shader parameters
or graphics settings and can be enabled, bypassed, moved or removed independently.
The list accepts up to 32 rows and one enabled frame-generation stage. Ordered
temporal processing requires the matching native MetalFX window/drawable path;
other supported temporal integrations use Simple controls.
A custom shader uses the native file chooser without changing another node.
Enabled rows are prepared before a changed chain is selected. Compatible live
hosts apply published changes during play, including managed model switches.
A process started without ordered execution requires another launch.

**Return to simple** removes the advanced plan and resets the game's shaders,
scaling and frame generation to their off/default settings. Game preferences,
save data, global imported-filter registrations and original source files remain
in place. Existing simple settings are retained as migration data while an
advanced plan is active.

Settings → Graphics → **Advanced presets** uses the same editor to save and
manage independent chain snapshots. The inspector's Advanced **Presets** section
can save the current chain, apply a copy or open its editor. Preset edits and
deletion do not modify games where a copy was applied. The
[graphics overview](../GRAPHICS.md) describes per-row sizes, preset controls and
the local neural-model library.
The contextual **Reconstruction + frame generation · 4×** template uses current
model bindings to create explicit Downsample ÷4, neural, spatial 4× and LSFG 4×
rows. Missing models or capabilities remain visible as requirements.

The CAS Sharpen preset applies AMD FidelityFX Contrast Adaptive Sharpening in
linear light and preserves frame alpha. It uses the shared Metal and OpenGL
effect paths and requires no download. Simple combinations place display
effects after reconstruction, scaling and frame generation; Advanced provides
manual ordering.
The separate Sharpen preset remains available. **Shader parameters…** reads the
selected effect's adjustable uniforms, labels, ranges and defaults. Parameters
are saved per game and apply during play on supported shared native, hosted web
and iOS paths while the effect is enabled. Native video shader selections and
parameters apply on the next launch. Reset parameters restores its defaults.
Automatic timer, frame-count and depth-availability values are managed by the
runtime and are not editable. Compile-time shader options remain in the source.

Combine effects applies two to four selections from CRT, Grayscale, Colour,
Sharpen and CAS in the displayed order. Other shader combinations use Advanced.
Each effect starts with its own default parameters. Controls beside each
selection change its order or remove it. Custom `.fx` files remain a separate choice and may define their own
multiple-pass technique. Native, hosted web and iOS games support changing effects,
their order, enable state and uniform parameters during play. Shared explicit
frame producers use the same live controls. A new effect is
compiled before selection changes; loading can briefly pause rendering. Shader
image textures are copied with the selected effect. Other hosts apply selection
and order on the next launch. Selecting another effect or reordering a
chain resets the saved parameters so values cannot transfer to unrelated shaders.

Live controls reuse the active shader and graphics resources while settings remain
unchanged. Control-file checks are limited to ten per second on each rendering
thread; unchanged files are not read again. Turning effects off bypasses their
GPU processing. Selecting a different shader or changing the frame-generation
model's processing options can briefly pause rendering while replacement resources
are created.

## Included shaders and custom effects

Included ReShade effects appear in the per-game preset list and are available
offline. Their resources, include files, textures and license notices ship with
MacLauncher and follow app updates. Included shaders have no separate download
or version selector. **Manage effects…** opens the shared local-filter table in
Settings → Graphics. Its **Download shaders…** button opens Runtimes → Graphics → Shaders,
with ReShade, libretro and MPV tabs for importing and editing local filters.
Optional **Collections** retain separate project versions, downloads and defaults.
Version refreshes and downloads remain explicit; installed collections work offline.
Effects use their upstream defaults; compiler or
presentation requirements are shown for unavailable effects rather than
silently substituting another shader.

The included selection contains SweetFX SMAA, Tonemap, Vibrance and Curves,
plus the RetroArch CRT Easymode, Lottes, GTU, zfast and CRT Royale effects. SMAA uses its
original lookup images and color passes without depth predication. The bundled
selection keeps the corresponding [upstream license notices](../../src/modules/shared/reshade/shader-collection/NOTICE.md)
with its resources.

Included MPV/libplacebo filters provide Anime4K Restore CNN (S), Restore CNN Soft
(S), Bilateral Mean Denoise and DoG Deblur. These original RGB hooks process frames
at their existing dimensions. Spatial scaling remains a separate control. They
are available offline when the libplacebo provider supports the game's process
architecture and macOS version.

The built-in **CRT** preset provides simulated scanlines, screen curvature,
rounded corners, adjustable softness, glow and a smooth edge fade.
**Shader parameters…** adjusts the simulated content height, beam width and
darkness independently. Curvature and edge shading remain separate controls.
A content height of 240
places one scanline per row of a 240-row image, retaining that spacing as the
window changes size. A value of 0 uses the render-target height. Pixel-art games
that enlarge their artwork before presenting can use their original canvas
height as an override; the final framebuffer does not identify that artwork
resolution. Patterns fade when the output cannot resolve their spacing.
Artwork and interface text can use different pixel sizes. Pixel softness is a
fraction of the simulated pixel size, so a lower content height also increases
the blur radius. Reducing softness and glow preserves small text without
changing scanline spacing; beam width and darkness control scanline contrast.
Supported native and Android hosts apply parameter changes during play.

Parameter controls also apply to supported included, imported and custom effects.
**Shader parameters…** opens the controls; **Hide parameters** collapses them
without changing the saved values.
Selecting **Custom shader…** opens a file chooser before changing the effect.
Canceling preserves the current effect; selecting a file applies its path and
clears parameters from the previous shader.
The Advanced effect chooser scrolls within the inspector, keeping the selected
chain visible and its effect search available while browsing the catalog.
Boolean, integer and floating-point scalar and vector uniforms with one to four
components expose their compiler names, labels, defaults and declared `ui_min`, `ui_max` and
`ui_step` annotations. The launcher API `getGameShaderParameters` returns this
metadata; `setGameReShade` accepts a `parameters` map from compiler names to
numeric component arrays, with booleans represented by 0 or 1. Values persist
per game, and resetting parameters restores the shader defaults. Combined
effects use separate names for each stage, so repeated effects retain independent
controls. Automatic source uniforms and FX preprocessor options are excluded.
MPV/libplacebo parameter metadata also retains its declared mode and named enum
choices. Named choices appear as menus; constant and define parameters rebuild
their provider state when changed.

**Custom shader** and **Choose shader…** select a local `.fx`, `.slangp`,
`.slang`, `.glsl` or `.hook` file. ReShade includes and Slang preset pass and
texture paths resolve relative to the selected source. MPV hooks are
self-contained files with embedded pass and texture declarations.
A Slang preset retains its declared pass sequence, scaling, textures and
parameters. `.glsl` and `.hook` identify MPV/libplacebo shaders; they do not select
RetroArch's legacy GLSL pipeline. Legacy RetroArch GLSL (`.glslp`) and Cg (`.cgp`) presets are separate
formats and are not accepted. Selecting effects does not modify game files or
download shader resources. Windows injector DLLs and executables are not required.

Settings → Graphics provides a shared **Shaders and filters** library.
**Import filter…** adds local `.fx`, `.slangp`, `.slang`, `.glsl` and `.hook` files, using each
filename as its initial name. Each row identifies its format. The table
edits names and paths on Enter or when the field loses focus; Escape discards an
edit. Imports distinguish matching filenames with folder suffixes; conflicting
edited names are rejected. An empty name restores a filename-derived name. The
file chooser beside each path can replace the selected file. Registered source
files can be up to 8 MiB; references preserve their original files and folders.
Replacing a filter's path resets saved parameters
in games using it; renaming a filter preserves parameters. Removing a filter
leaves its files in place.
Imported filters appear alongside the separate included presets in each game's
shader and filter selection. Changes are shared across launcher windows. Unavailable files
remain listed with their reason; the library is available independently of the
native graphics runtime. Importing and editing filters makes no network requests.

[RTGI](https://www.martysmods.com/rtgi/) is a paid shader distributed by its
publisher. Licensed local `.fx` files remain selectable through Custom effect;
MacLauncher does not acquire paid files or bypass licensing. RTGI, MXAO, ADOF and
screen-space reflections require real scene depth and supported shader features.

## Scene depth

Depth access depends on the actual rendering path. Native Metal capture uses a
stored, shader-readable depth attachment associated with the presented color
texture in the same command buffer. Hardware OpenGL capture uses the current
window's default depth buffer when its format and dimensions are compatible.
Unrelated offscreen buffers are not guessed from the final image. Menus and games
that discard depth or render it elsewhere can have no usable depth for an effect.
Automatic Metal capture keeps the original frame visible while waiting for a
matching depth attachment.

The optional `rsProcessFrameWithDepth` and `rsSubmitFramePresenterWithDepth` APIs
let a host supply its own real depth texture alongside the corresponding color
frame. A resolved, shader-readable R32Float or Depth32Float texture must match the
color source's device, dimensions, frame identity and origin. Depth32Float is
converted on the GPU; there is no CPU pixel transfer or color-derived depth.
The original color-only APIs remain available.

Window depth capture does not add depth to remote surfaces or existing explicit
hosts that submit only color. Available effect choices reflect that distinction.
Depth values remain raw: the effect's projection, reverse-Z, logarithmic-depth
and orientation settings must match the game. The included compiler defaults to
forward depth; custom effects can override its depth definitions. Camera
parameters, motion vectors and temporal jitter are not inferred from a picture.

## Presentation

The native frame encoder accepts separate source and output textures, frame
identity and colour metadata. Its caller owns GPU ordering, resource lifetime
and presentation. The native payload records encoding and presentation
capabilities separately in `features.graphics.presentation`.

Native process runtimes declare `graphicsHost: "window"` for automatic Metal,
hardware OpenGL and supported Core Animation color surfaces. This covers the
native SDL/VN players, ScummVM, EasyRPG, Ren'Py, Ruffle, Java graphics and native
app launches when they publish through those APIs. The same declaration enables
the shared controls without changing the runtime's renderer selection or game
settings. Shell-based Ren'Py and native app launchers retain their supplied scripts
and restore graphics-library variables after the system shell boundary.

Sandboxed launches retain the explicitly selected native graphics libraries
across protected macOS process entries. Library paths are resolved before
launch; the sandbox grants those files and the included processor's declared
native providers. Shader resources and models use their selected resource
bindings. Launcher credentials and unrelated injection settings are excluded.
An unavailable selected effect reports its preparation error before launch;
enabled stages are preserved rather than silently removed.

A window declaration identifies an adapter, not scene depth, motion vectors or
camera data. Those inputs remain separate per-game renderer capabilities. Java
and external/native apps can choose other renderers, and library-loading
restrictions still apply. Direct CoreGraphics drawing that does not publish a
supported layer surface is outside the automatic adapter. Inspection and archive
tools do not declare a graphics host.

A runtime that submits frames directly declares `graphicsHost: "explicit"` on
its runtime entry. Launch preparation then disables automatic presentation hooks
before loading the shared library. The host calls the shared frame API and retains
ownership of its own GPU ordering and presentation.

`graphics-settings.js` validates shared scaler and frame-generation configuration
and converts it to the native processor's environment contract. Preparation
requires both presentation support and an explicitly listed method in
`spatialMethods`, `temporalMethods` or `frameGenerationMethods`. It checks model compatibility
before returning any model path. Automatic hosts keep an inactive adapter ready
and can bind already installed models at launch for later activation.

**MetalFX Spatial** and **FSR1** process the current image. FSR1 uses AMD EASU/RCAS
spatial processing. Temporal reconstruction instead consumes matching colour,
depth, motion vectors and camera jitter from the game's renderer.
The spatial and temporal menus group Apple MetalFX, AMD FidelityFX, Lossless
Scaling and standard filters. FSR 1 appears under spatial upscaling; FSR 2.2,
FSR 3.1 and FSR 4.1 belong to temporal upscaling when the selected host supports
their inputs. Frame generation has its own control.
Simple lists common scaling methods and preserves a selected traditional filter.
Advanced groups the complete traditional filter catalog under **Standard filters**
in **Upscaling**. Alternate filter names share one menu entry; saved selections
retain their original method identifiers.

Simple combinations choose shader placement from input and geometry metadata.
Depth and motion effects precede geometry changes, imported reconstruction and
resizing shaders precede final fitting, and ordinary display effects follow
scaling and frame generation. Effects retain their order within a shader chain.
The legacy **Effects placement** control remains available for shader-only
settings; Advanced exposes each stage and its position explicitly.

The **Temporal upscaling** control selects an implementation for existing native
MetalFX temporal integrations or a renderer that submits the shared temporal
frame API. **Game default** preserves the renderer's own scaler. Methods are
listed only when the installed runtime includes their implementation and the
host has a compatible temporal input path. FSR2 and FSR3 additionally require camera
projection data. Colour-only captures, including Chromium surfaces, retain the
spatial choices instead.

FSR 4.1 runs through the included native Metal provider on macOS 26 or later
with Apple Silicon. Native Metal apps do not require DXMT or Wine. An existing
MetalFX temporal integration supplies the required textures, or the renderer
can submit them through the shared temporal frame API. FSR2 and FSR3 accept camera
data through the shared frame API or a camera integration paired with the native
MetalFX scaler. Camera inputs are matched to the exact scene frame; unsupported
projections or missing inputs preserve the game's original scaler.

Godot 4.4 and later 4.x versions can supply projection and textures through the Metal Forward+
compositor. Perspective, single-view scenes support this integration. The launcher
prepares the camera helper automatically and preserves the game's render scale;
Game default restores the original viewport scaler. Compatibility and Mobile
renderers, orthographic cameras and multiview rendering retain their original
temporal behavior.

Compatible 64-bit Windows games using Streamline can supply camera constants
through the included DXMT camera integration in CrossOver and Sikarugir. This
requires a supported interposer interface and matching DXMT components. The
launcher prepares the integration in its private game copy. Other native Metal
renderers can supply the same data directly without Wine; a final image or depth
texture alone cannot provide a reliable camera projection.

CrossOver and Sikarugir expose game temporal inputs through their installed
DXMT or D3DMetal NVAPI/NGX integration. Selecting a shared temporal method enables
this integration at launch; the game's DLSS option must also be enabled. The
runtime **Game temporal integration** option exposes MetalFX Temporal without
selecting a replacement and allows later live selection. These paths execute
MetalFX or the selected Metal implementation; they do not execute NVIDIA DLSS.
Changing temporal methods or sharpness can apply during play once compatible
inputs and the provider are available. Enabling Wine integration or adding a
provider requires another launch. The game controls temporal render resolution.

The native temporal ABI is declared in `src/modules/shared/reshade/temporal/frame.h`.
`rsProcessTemporalFrame` receives caller-owned Metal resources from one scene
frame and encodes into the supplied uncommitted command buffer. Temporal history
belongs to each owner; `rsReleaseTemporalOwner` releases it. The separate 24-byte
`MLTMCTL1` control packet carries the method and sharpness without changing the
image-only frame API.

FSR3 in the temporal control selects upscaling. Frame generation is a separate
control using LSFG; selecting FSR3 upscaling does not enable AMD frame generation.

Spatial scaling uses the actual source texture and the window's output dimensions.
Auto preserves the game's render resolution. Where the runtime controls source
allocation, Render resolution selects a smaller render target while keeping
the window or fullscreen output size unchanged. The percentage applies to each
dimension: 50% uses 2× upscaling, so 1920 × 1080 output renders at 960 × 540,
one quarter as many pixels.
Odd dimensions round up. A 1× selection uses the output dimensions directly.
Native window output uses physical backing pixels, including Retina scaling.
Resizing and fullscreen changes update the output dimensions without changing
the game's input coordinates. Display changes update native presentation timing.
Available multipliers follow the installed runtime's source-allocation support.
Simple source controls expose the selected runtime's advertised divisors.
Advanced engine controls can also provide fixed 480p or 720p heights;
explicit producers retain their advertised divisors. Native window paths need
an explicit source capability; generic Metal, OpenGL, hosted browser and native
video paths preserve producer allocation. These source settings allocate a
smaller render target rather than rendering a full frame and reducing it later.
Advanced **Output size** instead sizes each row's processing target, including
downsampling, independently of game allocation. Game scaling and frame
generation remain separate controls and default to Off. New videos default to
native Lanczos Sharp, with existing settings preserved.
Spatial methods retain their own format and dimension limits. When a frame
falls outside the selected provider's limits, the presenter uses bilinear
scaling and resumes the method when its dimensions fit again.
The frame result retains the requested method and reports Bilinear as the active
method with the reason. Bilinear also supports downscaling.

The Godot engine adapter changes 3D render scale while retaining the original
window drawable and 2D content. Source scaling applies to active root 3D views
using Forward+ or Mobile outside XR; Compatibility retains its existing scale.
For Advanced plans with a selected game-rendering size, **Source filter**
offers the adapter's declared native filters. Godot exposes Bilinear, MetalFX
Spatial and FSR 1 before interface composition. **Game original** preserves the
existing method; enabled temporal stages disable the other source choices.
Shared spatial rows retain their own position and processing sizes.
Selecting a scaler alone does not resize
arbitrary native game drawables or reduce other producers' render targets.

LSFG is an optional shared Metal frame-generation method for supported native
Metal/OpenGL windows, Chromium surfaces and iOS Metal game layers. It does
not require Wine. The per-game Frame generation control directly selects Off or
2×, 3×, 4× or 5× LSFG. For example, 3× requests two generated frames per game frame:
a 30 fps source targets 90 fps before display and processing limits. Turning it
off preserves the saved multiplier and processing options. Separate controls
select Quality or Performance mode, 16-bit or 32-bit precision, and motion
estimation scale.
Native, hosted web and iOS hosts also offer Adaptive pacing, a 30–240 fps target
and Smooth cadence. Adaptive generation varies work up to the selected multiplier
and limits its target to the observed display refresh rate. It does not cap game
rendering. Native view hosts follow the window's display; remote surfaces use the
display selected by Core Video. Smooth cadence favors an even output pattern.
On these hosts, scaling method, sharpness, LS1 quality, LSFG enable state, multiplier,
pacing, target, smooth cadence, precision and motion-estimation scale update during
play. Lossless Scaling models must be installed and selected before launch to
enable LS1 or LSFG while running. Changing the model version or render-resolution
multiplier requires another launch.
Compatible Lossless Scaling models must first be acquired in Runtimes → Graphics;
model files are not included. Frame generation is off
by default and can be used independently of ReShade effects or spatial scaling.

Frame generation accepts opaque SDR frames with display-driven presentation.
Its output cadence is determined by the source rate, display refresh rate, GPU
processing time and selected multiplier. Application-requested presentation
timestamps retain the original real-frame presentation path.

FSR1 provides AMD EASU reconstruction and RCAS sharpening through this shared
frame path. It accepts perceptual SDR frames at up to twice the source dimensions
on each axis, preserves alpha and needs no external model files. The per-game
Sharpness control ranges from zero to one. Equal source and output dimensions
leave scaling inactive. Scratch storage is bounded to three pending frames per
encoder and 256 MiB across encoders; a full queue skips new work without waiting
or altering the source frame.

## Lossless Scaling setup

Graphics is the first Runtimes sidebar entry. Its Upscaling section lists the installed
graphics components, their versions and requirements. MetalFX is provided by
macOS; FSR 1, FSR 2.2, FSR 3.1 and FSR 4.1 providers follow MacLauncher updates.
The FSR 4.1 model is included with its provider. These components have no separate
download step. Temporal methods require the renderer inputs listed in their
component information. Included ReShade effects are selected per game.

The shared Mac graphics pipeline provides scaling, frame generation and shader
effects through Metal. FSR1, MetalFX Spatial, sharpened cubic scaling and
included ReShade presets do not require Lossless Scaling. **LS1** and **LSFG**
require compatible resources from a purchased
[Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) copy.

MAKO is the Linux reference project for this pipeline. Its adapted model reader,
graphs and sharpened cubic shader retain upstream attribution. The scaler appears
as **Sharpened cubic** in the simple controls and **Mako** in Advanced effects.
MAKO does not require a separate runtime installation.

**Manage models…** beside the per-game Models selection opens Runtimes → Graphics:

- **Import Lossless Scaling DLL…** accepts a local DLL, including one installed
  through CrossOver. The original file remains unchanged.
- **Find in Steam / CrossOver** checks conventional Steam libraries, additional
  libraries recorded by Steam, Steam console depot downloads for Lossless Scaling,
  and standard CrossOver bottles. Compatible copies
  are imported without network access. Nonstandard locations can use Import.
- **Download from Steam…** uses the installed Mac Steam client and its current
  account to request the Windows depot, then imports compatible models after Steam
  reports completion. The account must own Lossless Scaling. CrossOver is not
  needed, and Steam's platform settings remain unchanged. Steam retains its
  downloaded files, including downloads stored inside its updated app bundle.
  Cancel in Runtimes stops waiting and automatic import; Steam may finish its own
  download. **Find in Steam / CrossOver** can import that download later.
- **Use SteamCMD…** is an alternative when Mac Steam is installed, and is the
  automatic download route when it is absent. It obtains Valve's macOS SteamCMD
  and opens Terminal for the Steam account name, password and Steam Guard prompts.
  SteamCMD requests the Windows files directly. Its sign-in is separate from the
  desktop client's session, and Rosetta is requested if missing. Compatible models
  are imported automatically; temporary downloads and sign-in files are removed
  on completion or cancellation. Cancel also stops the private SteamCMD process.

MacLauncher does not receive the Steam password or Steam Guard code. Network
access starts only from the download action. Steam sign-in, account entitlement
or an incompatible new DLL can prevent import; existing imported versions remain
available. Imported model labels include a short content hash to distinguish DLLs
with the same publisher version. The first import becomes the default; later
imports preserve an explicit default. Each game can select a different version.

## Local model storage

Runtimes → Graphics imports compatible Lossless Scaling DLLs and removes stored
model copies. Reload installed models reads local files only. Models are shared
by compatible game runtimes; importing a model does not enable graphics processing.
Per-game scaling and frame-generation selections use the installed native
adapter's available methods. Their controls appear only when those methods can
be presented. Supported active hosts apply managed model selections, scaler
settings and frame-generation options live. Model copies stay reserved while a
game uses them. Additional versions can be imported during play; healthy copies
are reused without changes, while active copies cannot be replaced or removed.

`src/modules/shared/reshade/models.js` manages local Lossless Scaling resources
independently of the selected game runtime. Acquisition uses `model-sources.js`
and `steam-models.js`, then the same validated import path.
`importModel` copies an explicitly selected DLL into launcher-owned storage,
inspects its resources with the included native compiler, verifies its SHA-256
identity and publishes the copy only after validation. Inspection does not load
or execute the DLL. Original files remain unchanged.

`listInstalled` reports stored versions and resource capabilities. Before use,
`resolveModel` verifies the selected capability and hashes the owned copy again.
`removeModel` removes only a stored copy. Acquisition and import belong in
Runtimes; game graphics options select installed resources. Selected methods use the active host’s declared presentation capabilities.
