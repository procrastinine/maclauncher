# Graphics and effects

MacLauncher's shared graphics layer applies per-game effects across supported
runtime presentation paths. Processing uses the GPU and keeps the original game
files unchanged. Graphics components and included filters ship with MacLauncher;
ordinary effects need no separate runtime download.

The inspector's **Graphics** section groups Simple controls into **Shaders and
filters**, **Neural reconstruction**, and **Scaling and frame generation**.
**Advanced…** in the same header opens the ordered effects list.
The [settings reference](runtimes/GRAPHICS.md) describes individual controls;
the [pipeline reference](GRAPHICS_PIPELINE.md) documents frame adapters and APIs.
Game shaders, upscaling and frame generation start off. Imported videos instead
start with native Lanczos Sharp scaling; existing per-item settings, including
Off, remain unchanged.

Supported shared presentation paths start with a lightweight effects connection,
including when all effects are off. Simple and Advanced can enable, disable,
reorder and edit effects during play. Model selections use the managed model
library; new imports remain available without restarting the game. Model weights
and optional processing providers load only when selected. Sandboxed games receive
read-only access to the two model stores, without access to neighboring launcher
data. Source allocation can change during play when the renderer advertises
live source controls; other allocations and new scene inputs retain their
runtime-specific launch requirements. Sessions started without a compatible
effects connection use the next launch for those changes.

Live-update help describes the running process's effects connection and supported
changes. Selected controls represent saved preferences; preparing or publishing
settings does not confirm that a frame has been processed. Graphics warnings
identify optional settings skipped during launch preparation.

Videos also provide **Preview settings** and **Export video…** in the inspector's
Video processing tools. Preview uses ordinary playback; export applies compatible
RGB shader, spatial and neural stages from the same settings to a separate file
at a selected output size. The [video reference](runtimes/VIDEO.md) describes
output, audio and provider requirements.

## Capabilities

| Feature | Implementations | Inputs and requirements |
| --- | --- | --- |
| Screen and color effects | CRT, CRT Royale, CRT Easymode, Lottes, GTU, zfast, grayscale, color, sharpening, CAS, SweetFX tone mapping, vibrance, curves and SMAA | Color frames; effect-specific textures and parameters accompany included filters. |
| Custom shaders | ReShadeFX, RetroArch Slang and mpv/libplacebo | A supported local shader or preset and its referenced files. |
| Spatial scaling | Downsample, nearest-neighbour, bilinear, bicubic, sharpened cubic from MAKO, MetalFX Spatial, AMD FSR 1, Lossless Scaling LS1 and available libplacebo filters | Color frames and supported output dimensions; LS1 additionally needs compatible imported models. Native video filters use the selected mpv version's registry. |
| Temporal upscaling | MetalFX Temporal, AMD FSR 2.2, FSR 3.1 and FSR 4.1 | Matching renderer inputs, including depth, motion and jitter; FSR2/3 also need camera projection. |
| Neural reconstruction | Portable MLX-DLSS provider | An ARM64 game or processing process on Apple Silicon, macOS 14 or later, an installed provider and a compatible local `.dlssmodel` package. |
| Frame generation | Lossless Scaling LSFG, fixed 2×–5× and adaptive pacing | Compatible imported models, opaque SDR frames and supported presentation timing. |
| Depth effects | Compatible local ReShade effects | Real, matching scene depth; availability depends on the renderer and effect. |
| Parameters | Declared numeric, boolean, vector and named-choice controls | The shader provider's original metadata; values are saved per game and per Advanced row. |
| Live changes | Simple and Advanced effect switching, ordering, parameters, scaling, neural model selection and frame generation | A compatible shared presentation connection. Source sizing follows the runtime's live source contract; new renderer scene inputs and native video shader/scaling bindings retain their launch requirements. |

Spatial filtering reconstructs one image. Temporal upscaling uses information
from the game's renderer and previous frames. Frame generation inserts images
between real game frames. These are separate controls; selecting FSR3 upscaling
does not enable AMD frame generation.

## Simple and Advanced

Simple controls select shaders, scaling and optional frame generation.
**Shaders and filters** selects appearance and restoration effects. Declared
image upscalers are listed under **Spatial upscaling**, which also offers
**Custom shader…**. That selection retains its own shader parameters and shares
the render or processing resolution control with the other spatial methods.
A fixed-scale shader keeps its declared scale; final fitting follows its actual
output size. Selecting a shader alone does not request a smaller game window or
render target. Native source sizing or virtual presentation is requested only
when a lower render resolution is selected.

Neural preparation leaves the other controls available and displays its pending
state. Turning neural reconstruction off cancels its pending preparation. A late
model result cannot enable it again. The initial Simple suggestion for frame
generation is LSFG 4× where available; subsequent frame-generation and upscaler
choices remain independent. Separately started model downloads remain visible
in Runtimes.

**Combine effects** chains two to four selections from CRT, Grayscale, Colour,
Sharpen and CAS in the displayed order. Other shader combinations use Advanced.
When combined with scaling, reconstruction or frame generation, Simple places
effects according to their input and size requirements. Depth and motion effects
run against source coordinates. Imported reconstruction and resizing shaders run
before final spatial fitting and frame generation. Display effects, including
CRT and colour filters, run last so their texture is applied to the final image.
Advanced provides explicit manual ordering.

With compatible final upscaling and LSFG, Simple can generate frames at the
smaller processing size and then upscale each delivered frame when this reduces
estimated GPU work. Advanced keeps the chosen row order.

Simple also accepts registered imported upscalers, including declared neural
mpv hooks. Their fixed output scale supplies the processing size automatically;
the selected spatial shader is followed by final fitting when needed.
No manual Advanced row sizing is required for that combination.
The same sizing control is available for a selected resizing shader without
enabling an additional spatial filter. **Render resolution** uses renderer source
sizing when available; otherwise **Processing resolution** downsamples completed
frames before the selected upscaler. Its 1.5×, 2×, 3× and 4× choices follow the
current physical output size without changing the window or fullscreen size.
Completed-frame downsampling reduces effect processing work, not the game's own
rendering work. **Auto · Game resolution** preserves the original source, and
already smaller inputs remain unchanged. Native video filters retain their
decoded-source sizing. Custom MPV shader metadata is read from the selected local
file.

The Simple **Neural reconstruction** section offers **DLSS 5 · Experimental**,
using MLX-DLSS with compatible local model packages, including DLSSMac imports,
when the Apple Silicon provider is available. Enabling it reuses a compatible
local model or offers model preparation with download consent. Cancellation
preserves the previous settings. Game processing starts at **Auto**, using the
current physical output size and source aspect ratio. The reduction divisor is
the shorter fitted output edge divided by 540, rounded to the nearest integer
and limited to 1×–4×. This selects 2× for 1920 × 1080, 3× for 2560 × 1440 and
4× for 3840 × 2160, and follows resize, fullscreen and Retina backing changes.
Already smaller inputs remain unchanged. Existing explicit processing scales
are preserved; **Use Auto** adopts automatic sizing. Video configurations
start at their decoded size without an additional reduction. **Options** holds
intensity and temporal reconstruction; the local
model selector and **Manage models…** use the shared model library. The separate
upscaler selector retains MetalFX, FSR 1 and other supported choices, and LSFG
remains independently selectable at 2×–5×. LS1 and LSFG reuse compatible installed
models or offer preparation for the selected quality and precision settings.

The automatic Simple chain performs temporal input processing, optional input
reduction, neural reconstruction, selected final spatial filtering and frame
generation in order, followed by ordinary display effects. Source-dependent
and imported reconstruction shaders use their required earlier positions. Auto
requests a smaller game source when the selected renderer or virtual-window
adapter supports adaptive allocation. Source allocation and completed-frame
processing use the same physical-output sizing policy. An already smaller game
source remains unchanged. When allocation is unavailable, the complete renderer
frame is reduced once before the neural row and fitted afterward; this fallback
lowers neural work while retaining the game's rendering cost. Scene-only engine
scales and explicit frame producers retain their declared source contracts.
Window geometry and the saved
spatial selection remain independent. **Automatic fit** uses MetalFX Spatial when
available, then bicubic or bilinear as supported, to fit reconstructed output
to the current window. Processing sizes and compatible managed model selections
update during play. Source allocation updates during play through an
advertised live source adapter. Compatible chains can instead downsample completed
frames when an allocation change is unavailable; logs identify the effective path.
If the neural provider, model or final spatial filter cannot be prepared at launch, Simple drops its
automatic reduction and source request while retaining the remaining effects.
Skipped Simple features are identified by a Graphics warning. If graphics
preparation cannot produce a compatible chain, the game starts with its original
rendering and the reason appears in the inspector and log. Explicit editor changes are validated before
replacing an accepted chain.
Advanced launches retain independent available effects when an optional stage
cannot be prepared, and identify skipped stages. Live effect edits and video
exports validate their enabled stages before publication. The saved selections
remain unchanged by launch fallbacks. A later per-frame inference failure passes through the current
stage input at its requested size.

During play, a model or method unavailable to the current process can remain
pending while independent compatible effects update. An existing prepared row
is retained when its replacement is unavailable; a newly unavailable row stays
inactive. The complete requested settings remain saved. Invalid ordering,
compilation failures and cancelled edits retain the previous publication.

**Advanced…** opens the current settings as an ordered list. **Add effect…**
offers shaders, spatial scaling, temporal upscaling, neural
reconstruction and frame generation, with
search and availability requirements. Rows run from top to bottom. Each row has
its own enable switch, parameters and position. Opening Advanced alone changes
no saved settings; the first successful edit selects Advanced mode.
When switching from Simple neural controls, its reduction and reconstruction
appear as explicit rows, including a window-relative Downsample target and final
fitting. A Simple Auto reduction uses a recent physical presentation size when
available; otherwise it becomes a manual 2× window-relative target when converted
to Advanced. Existing Advanced plans receive no automatic reduction
or hidden source-allocation setting; their order and sizes are configured
directly in the editor.

The Upscaling chooser groups bilinear, bicubic, nearest-neighbour and MAKO under
**Standard filters**, with Bilinear selected initially. MetalFX, AMD FidelityFX,
Lossless Scaling and imported model filters retain separate families. A row's
**Effect** menu groups individual methods by family; searching the chooser also
finds individual methods. Changing a spatial filter preserves the row's output
dimensions and scale. **Downsample** remains a separate reduction choice.

Effects that resize or otherwise change coordinates can invalidate scene depth
and motion data. Invalid ordering is rejected instead of supplying invented
inputs. Unavailable choices retain their requirement messages.

**Return to simple** keeps Simple settings when leaving an unedited preview.
After an Advanced edit, it clears the plan and resets the game's graphics
settings. It preserves the game, saves, unrelated preferences and shared filter
registrations. Advanced supports up to 32 rows, with one enabled frame-generation
stage.

Unavailable methods retain their requirements in the editor. A changed chain is
validated before it replaces the active plan. An unavailable selected stage
reports a preparation error before launch and retains the saved selection. Unsupported
frame dimensions or formats retain ordinary presentation rather than changing
window geometry or supplying fabricated scene inputs.

### Advanced presets

The contextual **Reconstruction + frame generation · 4×** preset uses the selected
or installed model bindings for Downsample ÷4, neural reconstruction, the selected
spatial filter at 4× and LSFG at 4×. Ordinary display effects remain last. Its
availability describes the current provider and model requirements; applying it
creates editable manual rows without acquiring models or saving a global preset.

Settings → Graphics has separate **Shaders and filters** and **Advanced presets**
tabs. Advanced presets use the same ordered editor as the game inspector. A
preset stores the chain, row settings, shader parameters and selected render
resolution. **Save preset**, **Save a copy**, **Discard changes** and **Delete
preset** manage the local library without changing game settings.

The inspector's Advanced **Presets** controls save the current chain, apply a
saved preset or open its editor in Settings. Applying replaces the current
chain with an independent copy; later preset edits and deletion leave applied
games unchanged. Presets are optional and use no network access. Referenced
shader files, filter registrations and models must remain available; each
game's graphics capabilities and file bindings are checked when applying the
chain. Saving a preset alone does not activate effects.

## Shader formats and filters

| Format | Provider | Preserved behavior |
| --- | --- | --- |
| `.fx` | ReShadeFX | Techniques, passes, supported uniforms, includes and lookup textures. |
| `.slangp` | librashader with Metal | RetroArch preset pass order, scaling, lookup textures and parameters. |
| `.slang` | librashader with Metal | An individual Slang shader and its declared controls. |
| `.glsl`, `.hook` | Shared libplacebo with MoltenVK/Metal texture sharing, or original mpv during video playback | RGB game hooks in shared processing; native video hooks retain declared source, luma, chroma and scaling phases. |

Included mpv filters provide **Anime4K Restore CNN (S)**, **Restore CNN Soft
(S)**, **Bilateral Mean Denoise** and **DoG Deblur**. These RGB filters preserve
frame size and can run alongside separate scaling controls. Their original fixed
shader constants remain intact; adjustable controls appear only when declared by
the selected shader.

The shared mpv provider accepts hooks applicable to RGB game images.
Luma/chroma-only hooks are available to native video playback, which supplies
those planes before conversion to RGB. The filename extension does not imply
that every shader can process a game frame. mpv's built-in
`--scale` algorithms are distinct from its custom-shader file format.
RetroArch's legacy `.glslp` and Cg `.cgp` presets are separate formats and are not
accepted by the Slang or mpv providers.

**Settings → Graphics → Shaders and filters** holds the shared table of local
filters. **Import filter…** registers a file, with a filename-derived initial
name. Names and paths remain editable; duplicate filenames receive folder
suffixes. Removing a registration preserves its source files. Included filters
remain separate and follow app updates, with no shader-version management in
Runtimes. Importing filters performs no network requests.

Dropping `.fx`, `.glsl`, `.hook`, `.slang` or `.slangp` files into the launcher
registers them in the same shared filter library. A drop can contain both games
and graphics files. Registrations keep the original shader location, includes
and textures; selecting the same file again, including through a filesystem
alias, reuses its existing registration. Importing alone activates no effect.

The MacLauncher application bundle declares these graphics formats and
`.dlssmodel` packages as Finder **Open With** choices. Finder opening, including
double-clicking a file after choosing MacLauncher as its default app, uses the
same import route. Documents received during startup wait for initialization;
an additional launcher instance forwards them to the existing instance.
MacLauncher does not change the system's default application for these formats.
Opening or dropping a `.dlssmodel` package imports an owned copy through the
local neural model library described below. Compatible model application bundles
and ZIPs use that route when their contained model manifests are recognized.
Other apps and archives retain game detection.

**Manage effects…** in the Simple inspector and Advanced chooser opens this
table. **Download shaders…** opens **Runtimes → Graphics → Shader library**.
The versioned library manages Anime4K, ArtCNN, Chroma from Luma and the mpv
shader collection. Version refreshes and downloads are explicit; installed
shaders work offline and appear in the shared selectors. Downloaded sources
retain their upstream license notices. These managed collections remain
separate from the filters included with MacLauncher.

When the same shader is installed in several versions, the collection's default
selects its source copy, includes and textures. Stable shader selections that
are absent from the default remain available from other installed versions.
Explicit version selections retain their selected version.

**Custom shader…** selects a local source through the native file chooser.
Canceling preserves the current selection. ReShade includes and Slang preset
passes and textures resolve relative to that source. MPV hooks are self-contained
files with their pass and texture declarations embedded in the source.
Registered shader entry files may be up to 8 MiB. Windows injector DLLs are not
needed.

Imported mpv hooks are grouped by declared behavior: upscaling, downscaling,
restoration, CRT, color or general filters. Descriptions that explicitly identify
CNN or other neural processing retain that distinction. Fixed linear
`WIDTH`/`HEIGHT` expressions that remain proportional to one input dimension
can supply a row's output scale, so a declared 2× hook receives a corresponding
processing target. Absolute pixel constants are not interpreted as multipliers.
Conditional resizing and display-dependent expressions use the presentation
target so the original renderer evaluates `WHEN` and `OUTPUT` at the current
display extent. Other unresolved geometry also uses the original renderer's
presentation target instead of a guessed input factor. These labels
do not replace libplacebo's validation of shader syntax, resources or RGB input
stages.

**Shader parameters…** shows the selected provider's declared controls;
**Hide parameters** collapses them. Scalar and vector controls retain names,
labels, defaults and ranges. Each Advanced shader row keeps separate parameter
values, including repeated uses of the same source. Named mpv choices appear as menus. Changing a
constant or define can rebuild provider resources; ordinary uniform changes
reuse them. Runtime-managed time, frame and availability values remain automatic.

## Scaling and resolution

Graphics processing has three separate sizes:

- **Game render size** is the image produced by the game. Where the runtime
  explicitly exposes source controls, Simple **Render resolution** can reduce that
  render target. Advanced **Game rendering** selects Auto, a divisor of 1.5, 2
  or 3 per dimension, or a fixed 480p or 720p height. Fixed heights preserve the
  presentation aspect ratio and stay within its dimensions. For example, 50%
  in each dimension renders one quarter as many pixels. The Godot engine adapter
  changes the 3D render scale while retaining the original window drawable and
  2D content. It applies to an active root 3D viewport using Forward+ or Mobile
  outside XR; Compatibility retains its game-selected scale.
  Other native and captured browser frames retain their producer's source
  dimensions unless the installed native window adapter advertises virtual
  presentation support. Its source controls use the same divisors while fitting
  the result to the current window. Explicit frame producers expose only their
  advertised divisors; hosted browser and native video paths retain their source
  dimensions. Unsupported source controls are omitted from the inspector.
  Simple hides **Render resolution** while neural reconstruction manages sizing;
  its saved source divisor applies again when neural reconstruction is off.
- **Effect processing size** is the image received and produced by each row in
  Advanced. A row receives the preceding row's output. Simple spatial processing
  can also reduce completed frames when renderer source controls are unavailable;
  the inspector labels that choice **Processing resolution**.
- **Presentation size** is the final drawable or window surface in physical
  pixels. Retina backing size can exceed the window's size in points.

New Advanced spatial rows start at Auto rather than inheriting a Simple source
divisor; Downsample starts at ÷2. LS1 uses the same explicit processing sizes as
other spatial filters. LSFG's 2×–5× multiplier changes frame rate and does not
multiply image dimensions.

Game rendering follows the selected adapter's capabilities. Adapters with live
source controls accept changes during play; other source requests are selected
before launch. An engine source adapter follows the
current render viewport as windows resize or enter fullscreen. Shared effects
follow the current physical presentation size as windows resize or move between
displays. Dragging, window size and fullscreen controls keep
their ordinary behavior. These controls do not change the macOS display mode.

When an adapter advertises source filters, a selected Advanced game-rendering
size also shows **Source filter**. **Game original** preserves the renderer's
filter; the other choices select its native scaling method. The Godot adapter
offers Bilinear, MetalFX Spatial and FSR 1 for scene scaling before the interface
is composed. Enabled temporal rows leave only Game original selectable.
Source filtering updates during play when the adapter advertises live source
controls; other adapters apply it on the next launch. The Godot adapter provides
live size and filter controls with its compatible integration. Spatial rows in
the ordered list remain separate shared processing steps.

Each Advanced spatial row has **Output size**. **Auto · Presentation size**
uses the presentation dimensions. **1×**, **1.5×**, **2×**, **3×** and **4×** multiply
the current row's input width and height; **÷1.5**, **÷2** and **÷4** reduce
both dimensions. **Window size** instead targets a percentage of the current
physical window, fitted to the row input's aspect ratio. For example, 50%
targets 960 × 540 in a 1920 × 1080 window and 1280 × 720 in a 2560 × 1440
window. It does not halve an already reduced preceding stage again.
**Downsample** provides reduction choices with bilinear
filtering and defaults to ÷2. **Custom** accepts whole pixel
dimensions from 1 to 16384 on each axis, including smaller dimensions for
downsampling. Downsample also accepts only a width or height, preserving aspect
ratio within that limit; other filters require both dimensions. Downsample never
enlarges its input. A 2× setting doubles both axes and produces four times as many
pixels; two successive 2× rows produce four times the width and height.

These controls size GPU processing targets across supported presentation
adapters. They do not require the game to support render-target allocation and
do not change the game's render size. For example, an Advanced chain can reduce
a 1920 × 1080 frame to 854 × 480 with Downsample, apply a filter at that size,
then use a 2× spatial row to produce 1708 × 960 before presentation. A final
presentation fit handles any remaining size difference.

Native video Simple filters run inside mpv against decoded frames and configure
luma, chroma and downscaling together. The selector combines the original
player's available filters with separate shared methods. Native-handled Simple
filters are excluded from shared scaling to avoid processing them twice.
Advanced processing-size rows retain their saved position in the shared chain.
The video window remains freely resizable; native filters use its presentation
size without a game render-resolution control.
Players with a live graphics connection update native filters and compatible
shader prefixes during playback. Prepared shader revisions retain their source
filenames and parameters without reusing stale compiled contents. The selected
player version and decoder remain bound to that playback session.

Automatic window capture preserves the game's chosen render resolution unless
its renderer has a supported source-allocation integration. Selecting an
upscaler alone does not make an arbitrary game render fewer pixels. Native and
iOS window adapters preserve producer drawable allocation.

Each spatial method retains its own dimension and format requirements. Bilinear
supports both enlargement and reduction. An incompatible frame retains bilinear
presentation with the active method and reason reported separately; the selected
upscaler resumes when its requirements fit. Sharpening controls apply to
supported methods. MetalFX comes from macOS; FSR1 and sharpened cubic require no
models.

Temporal methods are enabled only for supported renderer input paths. Native MetalFX
integration, the shared temporal API, supported Godot Metal renderers, and
compatible Wine/DXMT integrations supply their corresponding inputs. FSR4.1's
native Metal provider requires Apple Silicon and macOS 26 or later. A final
color image, screen capture or LSFG motion estimate cannot substitute for game
motion vectors and camera data.
When a runtime declares its supported scene methods, Simple shows only those
methods. A saved unavailable choice remains visible with Game default available
to restore the original rendering.

Placing a temporal method inside an Advanced chain has a narrower contract:
the native MetalFX window adapter must supply a full acquired drawable and its
matching classic command buffer. Other supported temporal paths use Simple
controls. The chooser reports the selected renderer's requirements.

## Neural reconstruction

Neural shader filters and the MLX-DLSS model row use separate providers. A CNN
declared in an imported `.glsl` or `.hook` file runs through its shader pipeline;
the MLX-DLSS row loads a `.dlssmodel` manifest and weights. Their neural
classification does not make their formats interchangeable.

Runtimes → Graphics → **Neural models** manages a local `.dlssmodel` library.
**Import model…** accepts a package, an application containing compatible
packages under `Contents/Resources/models`, or a ZIP containing those packages.
Standalone package ZIPs are also supported. Import copies only the manifests,
declared weights and accompanying application or archive license notices into application storage;
it does not execute the application. A source containing several compatible
packages adds them to the same library. Reload refreshes the library, and
removal preserves the original source.
Repeated requests for the same model source share one import. Closing
MacLauncher cancels unfinished imports and waits for temporary copies to be
removed.
Local selection and library status validate the manifest schema, architecture,
declared tensor types, layouts, shapes, unique names and stateless model contract
without reading weight contents. Managed import and explicit model resolution
verify the declared weight checksum. Tensor contents are validated by the
provider when loading a model. Supported packages
use MLX-DLSS transformer architectures, with a manifest up to 1 MiB and weights
up to 8 GiB. Application and ZIP imports accept up to 16 packages with 8 GiB
combined weights. Raw weights require their compatible package manifest.
Model weights are not included in MacLauncher. **Download model…** offers the
pinned [DLSSMac 0.1.6 release](https://github.com/Mappsnet7/DLSSMac/releases/tag/v0.1.6)
after download consent. The 320 MB ZIP is checked against its recorded size and
SHA-256, then only compatible models and accompanying notices are imported;
the application is never installed or executed. Temporary download files are
removed after completion, cancellation or failure. An installed library model
is reused before another download is offered. Local imports remain available.
Download cancellation also covers checksum verification and model import.
Converted NVIDIA model weights retain their original ownership and are separate
from the application's Apache-2.0 source license.
Simple and Advanced neural controls can select a library model or choose a
separate local file.

Selecting a model-based method in Simple graphics starts setup when a compatible
model is missing. Neural reconstruction offers the consented model download.
Lossless Scaling first checks conventional Steam and CrossOver installations,
then offers Steam download or DLL import when needed. Compatible installed
models are reused, and cancellation leaves the game settings unchanged.

Incomplete managed model copies remain listed for removal. Importing the original
source again repairs its stored copy. **Download model…** can restore a damaged
downloaded neural model after fresh consent; declining or cancelling preserves
the existing copy and source files.

Advanced offers an MLX-DLSS row when its portable provider is
available for the selected runtime architecture. **Choose model…** selects a
local `.dlssmodel` directory or imports a compatible application or ZIP into
the shared library; **Intensity**
ranges from 0 to 1 and defaults to full model output at 1. Lower values blend
the reconstruction with the input.
Models remain separate managed or local files.

The portable provider runs on supported Apple Silicon Macs, including M2, and
requires macOS 14 or later. It is separate from M5-specific DLSSMac binaries.
**Temporal reconstruction** estimates motion between captured frames and
retains history, with additional GPU work. This estimate is separate from the
game-renderer inputs required by MetalFX Temporal and FSR2/3/4.
Processing remains in the ordered graphics chain, allowing a smaller Downsample
output to precede reconstruction and another upscaler to follow it. Provider
availability and model compatibility determine whether the row can run.
Simple effects remain the default controls.

## Frame generation and models

LSFG offers fixed 2×, 3×, 4× or 5× generation. Adaptive mode varies generated
work up to that ceiling and a 30–240 fps target, bounded by the observed display
refresh rate. Smooth cadence favors an even presentation pattern. Quality or
Performance, 16-bit or 32-bit precision, and motion-estimation scale tune the
model's workload. These settings do not increase the game's simulation rate.

**Runtimes → Graphics** imports compatible LS1/LSFG models from a purchased
Lossless Scaling DLL or downloads the owned Steam depot after an explicit
action. Acquisition does not require Wine. Inspection reads resources without
executing the DLL. The original file remains intact, and installed models are
shared across games. Model selection is per game; updates are explicit.
Advanced rows keep independent model and quality selections. New rows use a
compatible library default; an unavailable model selected by an existing row
remains selected until changed.
Local import and installed-copy discovery can be cancelled. Closing MacLauncher
waits for their temporary model copies to be removed.

Supported shared presentation hosts can select compatible managed LS1 and LSFG
models during play. Older running sessions retain the model access established
at launch. Source-resolution changes update during play through an advertised
live source adapter, and apply on the next launch for other source paths.
Window resizing, downstream processing sizes and compatible controls remain
available during play.
Removing an installed model respects active game leases.

## Runtime processing status

For a running game with graphics enabled, **Runtime status** shows shared
processing observations while the section and inspector are open.
Simple live neural activation also reads status for up to two minutes while
waiting for its first completed frame, including with the section collapsed.
The wait ends on matching completion, reported fallback, Off, Stop or the time
limit; pending activation does not disable graphics controls. Prepared
settings, encoded commands, completed GPU work and presented frames are separate
states. Counts cover observed work while status is open for the current processing
context, not game or display FPS. A paused image may produce no new observations.
Presentation is reported only after its presentation callback; some rendering
paths report completion without a separate presentation observation.

The view includes actual input and output dimensions, per-row methods and
fallback reasons, and saved changes that remain pending while an earlier
compatible setting runs. Observations from an earlier prepared revision are
identified as previous settings. A missing report does not establish a rendering
failure. Reports without sufficient settings identity are labelled unconfirmed.
Native renderer filters, including video-player filters, can run outside
the shared processing path.

Status uses a short consumer lease and requires no diagnostic recording. Closing
the view ends queries; publication stops when the lease expires. Off starts no
status capture, GPU work, recorder or polling worker.

## Runtime coverage and GPU ownership

| Presentation path | Source | Available scene data |
| --- | --- | --- |
| Native window | Supported Metal, hardware OpenGL and Core Animation publishers | Color; matching depth where the adapter can retain it; temporal data only through its dedicated renderer integration. |
| Hosted browser | The game host's surface | Color and presentation timing. |
| Explicit runtime | Runtime-supplied Metal textures | Color and any additional matching inputs supplied through the frame APIs. |
| iOS application | Supported Metal layers through PlayCover/Catalyst integration | Color and corresponding supported renderer inputs; the application retains its drawable allocation. |
| Completed bitmap | Supported Quartz/`CGImage` publishers | Color, dimensions and timing; one upload precedes GPU effects. |

A declared graphics adapter does not guarantee that every renderer in a process
uses that path. Individual drawing operations, unsupported direct Quartz output
and partial dirty rectangles are not complete game frames. A mac32 or other
runtime can supply its completed frames through the same explicit interface.

Metal textures remain on the GPU. OpenGL uses the shared texture/surface bridge.
mpv/libplacebo shares the same physical Metal device through MoltenVK, using
GPU events to order access. Ordinary effect passes do not require CPU readback.
Intermediate targets and in-flight work are bounded and remain owned until their
GPU reads finish. Bypassed effects perform no effect processing; unchanged live
settings reuse compiled resources. Launch preparation verifies the selected
components and reuses unchanged prepared included or registered shaders.
Custom shader files are prepared again at launch. Shared presentation hosts
retain a graphics bridge and empty plan so effects can be enabled during play.
An empty plan keeps the original presentation active and loads no model weights.
Other hosts skip shared graphics preparation when no effects are selected.

| Component | Process architecture | Minimum macOS | Additional requirement |
| --- | --- | --- | --- |
| Shared FX and Slang components | ARM64 or x86_64 | 13 | Supported frame adapter and effect inputs. |
| Shared mpv/libplacebo provider | ARM64 or x86_64 | 15 | RGB-compatible hooks and shared GPU texture access. |
| Catalog mpv video player | ARM64 | 14 | Installed managed player; newer versions retain their declared requirements. |
| Live MLX-DLSS provider | ARM64 | 14 | Compatible local `.dlssmodel` package. |
| Graphics video exporter | ARM64 | 14 | AVFoundation-decodable SDR source with one video track; selected effects retain their provider requirements. H.264 MP4 output with AAC audio. |
| Offline neural video processor | ARM64 | 26 | Compatible model and AVFoundation-readable source video. |
| Native FSR 4.1 provider | ARM64 | 26 | Matching renderer inputs and a supported temporal path. |

The loading process's architecture and selected provider determine availability.
Native mpv handles its own shader phases and filter registry independently of
the shared libplacebo provider's higher platform floor. Game source files and
shared filter resources are not duplicated into independent runtime installations.

## Integration and reference

- [Graphics settings](runtimes/GRAPHICS.md): complete inspector controls, CRT
  tuning, depth, temporal integrations and model acquisition/storage.
- [Graphics pipeline](GRAPHICS_PIPELINE.md): module declarations, ordered plans,
  resource ownership, programmatic controls and frame contracts.
- [Video playback](runtimes/VIDEO.md): local media, native video scaling and
  preview and export of compatible graphics settings.
- [Native graphics API](../src/modules/shared/reshade/native/README.md): Metal
  frame processing, presentation, depth and temporal interfaces.
- [Attributions](ATTRIBUTIONS.md): upstream sources and license notices.

The graphics layer processes video. Runtime audio volume and mute controls are
separate; this layer does not supply an audio DSP chain.
