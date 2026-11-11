# Graphics and effects

MacLauncher can change how a game looks by applying graphics effects to the images it draws. These effects run on the GPU through one shared graphics chain, which serves native macOS apps, browser games, Android and iOS apps, Wine and the engine runtimes alike. Shaders, processing sizes, models and output settings are also all edited in the same editor.

## How the chain works

For each frame, a game produces a completed image. The graphics chain is an ordered list of up to 32 effect rows that runs on that image from top to bottom. Each row receives the image produced by the row above it, and the last image is fitted to the window. The chain itself runs in MacLauncher's graphics processor, a native component that ships with the app and attaches to the running game.

Every row has one of five types, named by what it does to the image:

| Type | Input and output | Examples |
| --- | --- | --- |
| Image filter | Image to an image of the same size | Color, CRT, sharpening, restoration, LUTs, DLSS neural rendering |
| Downsample | Image to a smaller processing image | Area and other kernels, fixed reductions |
| Upscale | Image to an enlarged image, or one fitted to the window | Spatial filters, fixed-scale neural models and shaders |
| Temporal upscaling | Scene frame and its history to a reconstructed image | MetalFX Temporal, FSR, Arm ASR, Snapdragon GSR 2 |
| Frame generation | Consecutive frames to a denser sequence of images | Lossless Scaling LSFG, MLX interpolation, RIFE, VideoToolbox interpolation, MetalFX image interpolation, Vision optical flow, Automatic |

Most effects need only the completed image. Color filters, resizing and image reconstruction all work this way. Scene effects also need data from the game's renderer that matches the image: depth for depth effects, and depth, motion vectors and camera jitter for temporal upscaling. This renderer data is called the scene guides. Some providers, the components that implement a method, also need the camera projection. Whether a game supplies this data depends on the running process and its [renderer integration](SHARED_PROCESSING.md). The [frame-source and scene-input tables](INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs) list what native GPU frames, browser window streams, uploaded bitmaps and video decoders each supply. A missing input affects only the rows that need it.

Shaders that operate on luma and chroma planes also work on game images, because the shared libplacebo provider derives those planes from RGB. Hooks that need a video decoder's original planes or metadata run only in native video playback, where mpv applies those shader phases itself. The [video guide](../game-types/VIDEO.md) describes playback and export.

Three sizes stay separate: the size the game renders at, the size each row processes at, and the window. **Game resolution** changes the first, Downsample and Upscale rows change the second, and the window keeps its size throughout. [Rendering, processing and output size](#rendering-processing-and-output-size) describes each one.

Further reading:

- [Renderer integrations](SHARED_PROCESSING.md): how specific runtimes supply depth, motion and render-size control.
- [Graphics pipeline](PIPELINE.md): the architecture and an index of the pipeline references.
- [Graphics providers](PROVIDERS.md): each algorithm and shader format, with its image, history, guide, model and color requirements.
- [Neural models and packages](NEURAL_RESTORATION.md): model architectures, package formats and imports.
- [Frame APIs](FRAME_API.md): the interfaces runtimes use to submit frames and control render size.

## The graphics chain

Each game's chain is edited in the game inspector, under its **Graphics** heading. A checkbox in that heading turns the whole chain on or off, and while it is off, the chain keeps its rows, sizes, parameters and model choices. Turning it off in a running game whose FidelityFX upscaling MacLauncher performs through the [FidelityFX API adapter](../runtimes/CROSSOVER.md#fidelityfx-api-adapter) also hands those dispatches back to the game's own FidelityFX library until it is turned on again. The heading's **⋯** menu also holds the [presets](#presets) and **Clear effects**.

### Simple and Advanced

The editor has two views of the same chain, chosen with the Simple/Advanced selector. Both views edit the same settings, and switching between them keeps every effect.

**Simple** shows one dropdown for each group of methods, with the options of the selected method beside it. The groups follow input and output: **Image filters**, **Resize** (Downsample and Upscale) and **Temporal**, which holds both temporal upscaling and frame generation. Several image filters can be active in one chain, and model and shader labels show their declared scale. When a shader is selected in or dropped on a row, it appears in that row and uses its size controls: **Output size** for a shader that renders at a requested size, or the declared scale followed by the row's window fit for a fixed-scale shader. **Motion clarity** is a separate main control.

**Advanced** shows the full ordered chain, and a custom order made there stays intact when the view changes. When more than one resizing or temporal effect is active, Simple instead shows that group as **Custom**, with an action that opens it for editing.

Large method selectors include a search that works from the keyboard: the arrow keys move through the results, Enter selects one, and Escape closes the picker and returns focus to the selected method. Beside the results, **Manage filters…** opens the shared [shader library](#shader-library) with the matching type selected, and filters imported there appear in compatible selectors immediately.

### Rows in Advanced

In Advanced, a row is added with **Add effect…**, which first asks for the row type (**Image filter**, **Downsample**, **Upscale**, **Temporal upscaling** or **Frame generation**) and then searches the methods compatible with it. Image filters keep the image size, and DLSS neural rendering is one of them. For a shader, the type comes from its declared output geometry:

- A fixed 2× shader, or one that conditionally doubles toward the window size, is an Upscale.
- A fixed reduction is a Downsample.
- A shader that renders at a requested size is listed under each resize direction it declares.
- A shader whose size cannot be determined from its declarations is an Image filter marked **Unknown size**.

Every shader runs through the same execution path, and imported shaders join the same library.

Each row expands to show the method selector for its input and output type, an enable switch, parameters, reorder buttons and a remove button. Rows can also be moved by dragging or with Alt-Up and Alt-Down.

**Options** and **Details** show each row's observed input and output pixel dimensions, including those of filters that keep the size. Match window, a percentage of the image or window, and a pixel width or height are distinct size choices. Whichever is chosen, the window keeps its visible size while the processing resolution changes.

Changing one row leaves the parameters of the other rows alone. Existing compound shader selections keep their passes, while new combinations use ordinary rows. Opening the editor or expanding a row does not change the saved chain. **Clear effects** in the **⋯** menu removes every row, and after the effects are cleared or a preset is applied, **Effects replaced** with **Undo** appears beside the heading until the next edit.

### Saving, preparation and status

Edits are saved immediately. The resources that a changed chain needs, such as compiled shaders and loaded models, are then prepared in the background, and the controls stay usable while shaders compile and models load. Turning **Graphics** off can interrupt this preparation. When an optional input is missing or unsupported, the stages that do not depend on it keep running, the original rendering stays available, and the saved settings are kept. A control whose change needs a renderer integration set up at launch says so.

Badges show whether a change is being saved, prepared, handed to the running game or observed running on the GPU. **Applying…** means a replacement chain has been handed to the game. **Active** on a row means the runtime has done matching work for that row. **Details** shows dimensions, counters and fallback reasons, and its counters measure processing separately from the game's frame rate. It also shows each row's measured GPU time. This is the row's own GPU interval, or, when the row shares a command buffer with other rows, that buffer's time, with the other rows named beside it.

### Presets

A preset is a saved chain that can be applied to a game. The Graphics heading's **⋯** menu lists the available presets under **Apply preset**, and it also has **Save as preset…**, which stores the current chain, and **Manage presets…**, which opens Settings → Graphics → **Presets**. Applying a preset copies its chain into the game, so editing the preset later does not change the games it was applied to. Presets store references to the shared shaders and models they use. Preset lists update across open launcher windows, and unsaved editor drafts stay intact.

Presets can also show what their chain costs. While a running game uses the same rows as a preset, and Details or the performance overlay measures them, the preset records the chain's total GPU time and the game's image size. The preset lists then show that last measurement. A new measurement replaces it, and editing the preset's rows removes it.

## Shader library

Every shader that the editor can use is held in one shared shader library, which reads these formats:

| Format | Provider | Resources |
| --- | --- | --- |
| `.fx` | ReShadeFX | Techniques, passes, uniforms, includes and lookup textures. |
| `.slangp`, `.slang` | librashader with Metal | Preset passes, scaling, textures and parameters. |
| `.glsl`, `.hook` | libplacebo or native mpv | Hook passes, embedded textures, declared scaling and parameters. |
| `.cube` | GPU libplacebo LUT hook | 1D tables, 3D tables and combined shaper/3D tables. |
| `.fs`, `.isf` | ISF on Metal | Declared parameters, image resources, multiple passes and persistent targets. |
| `.hlsl` | MagpieFX on Metal | Format 4 parameters, includes, image/DDS assets, authored geometry and compute passes. |

The library is managed in Settings → Graphics → **Shaders**, which **Manage filters…** opens with its type filter set to the row's type. It lists included, collection and imported shaders together, with the same names, input and output types and availability as the inspector. A shader can be renamed there, which changes only its display name, and its source details show file paths. An imported shader can also be pointed at a replacement file or removed from the library; removing it keeps the original files and the resources that depend on them.

Shaders are added with **Import filter…**, which registers an original local file. Dropping shader or LUT files on the launcher, or opening them through Finder, also adds them to the same library. In editable fields, Enter or leaving the field saves, and Escape cancels.

Where a shader appears is decided by its authored output size, scale factor, stage dependencies and resize declarations, and its name does not decide its type. In search results, shaders keep their algorithm groups and show compact output-size labels, and contextual help explains the placement requirements.

### Included effects

Included effects ship with the app and update with it:

- the built-in **CRT**, **Grayscale**, **Colour** (vibrance), **Sharpen** and **CAS Sharpen** effects, and **Combine effects…**, which runs two to four of them as one row;
- SweetFX SMAA, FXAA, Tonemap, Vibrance and Curves;
- CRT Easymode, Lottes, GTU, zfast and CRT Royale;
- Image color balance, threshold deband, pixel palette and soft bloom;
- **Daltonize**, LMS color-vision simulation and error redistribution with adjustable strength;
- SSimSuperRes, an mpv hook that refines an upscaled image against its lower-resolution source;
- anisotropic Kuwahara;
- the native image effects: Histogram exposure, Local Laplacian, CMAA2, XeGTAO, CACAO, Depth fog, Depth outlines, Estimated depth fog, Screen-space reflections, FidelityFX DoF, FidelityFX Lens and FidelityFX Blur.

The included **CRT** effect has these parameters: CRT strength, Simulated content height, Scanline beam width, Scanline darkness, Pixel softness, Phosphor glow, Screen curvature, Rounded corners, Edge shading and Screen edge fade. With the default Simulated content height of 240, the effect keeps 240-row spacing as the window changes size; a value of 0 follows the render target.

**CAS Sharpen** applies AMD Contrast Adaptive Sharpening in linear light and preserves alpha. **FXAA** is SweetFX's unchanged ReShade FX version of NVIDIA FXAA 3.11 at quality preset 15, with Subpix, Edge Detection Threshold and Darkness Threshold parameters. Its first pass stores luma in the alpha channel for the second pass, and its output alpha keeps that luma. The sources and licenses of the included shaders are recorded in the [collection notices](../../src/modules/shared/reshade/shader-collection/NOTICE.md), and the [provider reference](PROVIDERS.md#shader-formats-and-image-effects) describes the algorithm and inputs of each native image effect.

### Collections

More shaders are available as downloadable collections. Beside **Library**, a **Collections** sub-tab lists these shader collections with their versions, installation state and defaults, and once installed, their shaders appear in the inspector under their input and output category. The collections are refreshed and installed only on request: Anime4K, ArtCNN, Chroma from Luma, CuNNy, ACNet/ARNet, RAVU/NNEDI3, Vidvox ISF, libretro Slang, MagpieFX, CShade, prod80, FXShaders, qUINT, NiceGuy shaders, Visibility bitmask lighting, AstrayFX, OtisFX and the mpv shader collection.

Some collections include:

| Collection | Contents |
| --- | --- |
| CShade | Effects driven by optical flow and motion estimated from the image, and average and spot exposure. |
| prod80 | Color grading and LUT resources. |
| FXShaders | NeoBloom and ArcaneBloom. |
| libretro Slang | Pixel-art reconstruction (xBRZ, SABR and pixel-art scalers), dedithering, median and bilateral restoration, CRT halation and shaders that use image history. |
| NiceGuy shaders | Screen-space lighting, reflections, depth fog and image effects, with their original textures. |
| AstrayFX | RadiantGI indirect lighting, GloomAO ambient occlusion, DLAA Plus, NFAA and temporal anti-aliasing, Depth Cues, Smart Sharp and Clarity sharpening, bloom, lens flare, image trails and the Limbo Mod and SnowScape looks. Its author permits only unmodified copies, and its files are installed exactly as published. |
| OtisFX | Cinematic depth of field, adaptive and height fog, depth haze, darkening and directional blur, Emphasize, MultiLUT and PandaFX grading, golden-ratio guides and borders, with their original bokeh, noise and lookup textures. |
| Visibility bitmask lighting (SSRT3) | Indirect lighting through two entry points, lighting only and diffuse composition. It reads the game's actual depth, normals, radiance and camera matrices. |

The versions of a collection come from its upstream project. **Refresh versions** reads Anime4K's releases and, for every other collection, the newest commit on the default branch of its repository. A release is listed when it has an Anime4K archive in a format MacLauncher extracts (ZIP, gzip, xz or bzip2 tar, or disk image), and a ZIP archive is preferred when a release offers several. The download is checked against the size and SHA-256 value that GitHub lists for it, as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity). A release removed upstream leaves the list. A commit, however, cannot change, so it stays listed after later ones. If a new commit lacks the collection's license notice, a source file that MacLauncher's adaptation of the collection needs or any supported shader, it stays listed with that reason. Installation passes over such a commit, and earlier commits remain installable.

Each installed collection records the exact upstream revision it came from. **Set default** records the chosen collection version, and installing or removing another version keeps that choice, even when the saved version is no longer available. No collection version is recommended over another, and the recommended effects and their menu order do not depend on which collection version is selected.

### Shader files and parameters

A saved chain can name a downloadable collection that is missing. In that case, Play offers to download it, and after consent, the collection's version list is fetched if needed, the collection is installed and graphics preparation resumes. Browsing the library, by contrast, stays offline. If the download is declined, that effect is unavailable, while the rest of the chain still runs.

A row can also use a shader file directly. **Custom shader…** and **Choose shader…** select a local entry file of up to 8 MiB, and its includes, preset passes and textures are read from their original locations relative to that file.

**Shader parameters…** shows each declared parameter with its name, default and range, including vectors, booleans and choices. Parameters keep their original labels, ranges and defaults in each row, and each use of the same shader keeps its own values. Changing a uniform reuses the prepared resources; changing a compile-time constant rebuilds them.

**Import options…**, **Copy options** and **Paste options** follow the parameters. Import takes matching values from a RetroArch `.slangp` or ReShade `.ini` preset, and Copy and Paste move a row's values as preset text. [Shader options](EFFECT_PLANS.md#shader-options) describes the parsing and matching.

A shader whose compiled program reads depth also shows **Depth input**. It holds the game's reversed, logarithmic, far-plane and multiplier definitions, which all of that game's depth shaders share, and changing them recompiles those shaders. Custom ReShade effects can override the compiler's forward-depth definitions. [Renderer integrations](SHARED_PROCESSING.md#scene-depth) describes where the depth comes from.

### MagpieFX shaders

MagpieFX shaders are written in HLSL, so preparation compiles their original pass bodies outside the game process and stores the resulting Metal resources, which are not changed afterward. At run time, the passes encode into the caller's Metal command buffer. Authored output dimensions keep their expressions and intrinsic scale, while an effect that does not declare its output dimensions takes the size selected for its stage.

Collection imports resolve parent-relative includes and assets within their declared folders, and standalone imports resolve them from the entry file's folder. Windows and Unix path separators both work, DDS lookup textures keep their channels and mipmaps, and optional FP16 declarations can use the equivalent FP32 path.

ISF and MagpieFX rows convert to sRGB SDR locally when the source requires it. Other compatible rows, however, keep the source's native range.

### CUBE LUTs

A CUBE file holds a color lookup table (LUT). When one is imported, its domain and input ranges, its red-fastest table order and the original files are kept. The LUT controls set the strength, trilinear or tetrahedral 3D interpolation, and separate encoded or linear transfer choices for input and output. On the GPU, the full table is used, including 65³ LUTs. Static texture preparation limits the generated hook to 16 MiB, and per-frame pixels stay on the GPU. A LUT package keeps its own color-space assumptions and license terms.

## Rendering, processing and output size

### Game resolution

**Game resolution** changes the size the game renders at, and with it the cost of the game's own rendering. It works through the runtime's source adapter (the part of a runtime integration that controls the render size), while the output window keeps its size. **Game default** keeps the game's own size. **Percentage of window** and **Height in pixels** request a smaller source; the divisors and fixed heights on offer depend on the adapter. For example, a 50% source for a 1920 × 1080 window renders at 960 × 540.

When the game's renderer cannot change its size, MacLauncher uses a virtual window if one is available, and otherwise downsamples the completed image before the other effects run. That fallback lowers the cost of the effects but not of the game's own rendering. [Game render allocation](FRAME_API.md#game-render-allocation-and-processing-extent) describes these strategies.

Where an adapter offers one, **Source filter** selects the scaling filter the game's renderer uses for the reduced image: **Game original** or one of the adapter's filters. Source filtering is separate from the effect rows. An adapter can also declare that its source scaler is reserved for temporal upscaling; [Godot](SHARED_PROCESSING.md#godot) does.

Native decoded video keeps its decoded size. Retina displays, window resizing and fullscreen follow the current physical output size.

### Processing sizes

**Downsample** and **Upscale** rows share three size modes:

- a scale of the previous image;
- a fraction of the window or fullscreen surface;
- a fixed resolution.

Downsample defaults to 0.5× its input. Upscale defaults to 100% of the window or fullscreen surface; this is how window fitting works, and there is no separate fit mode. The 540p preset means a height of 540 pixels with the aspect ratio preserved, and the height stays 540 pixels when the window changes. Custom sizes accept a width, a height or both, from 1 to 16384 pixels; giving one dimension preserves the aspect ratio. Each row's **Output size** applies to that row only, and a scale applies to the output of the row before it.

MetalFX Spatial renders at the requested output size. Fixed-scale models and shaders, by contrast, keep their intrinsic scale, and a separate resize row or the final fit changes the resulting size. A chain can, for example, run Downsample → neural reconstruction → Upscale → CRT. A smaller processing size lowers the work of the effects that follow it, but the game's own rendering cost changes only through **Game resolution**.

In Simple, **Upscale** chooses its input size automatically: half size for general spatial filters, or the reciprocal of a uniform intrinsic scale, so a 4× model starts at 25% of the presentation size. Its output fits the window unless a manual size is selected. Turning Upscale off removes the input size it added, and manual sizes stay. Simple neural rendering picks a compatible installed model and starts with a fixed input height of 540 pixels, preserving the aspect ratio and leaving smaller inputs at their size.

### Window fitting

Every chain ends on a final presentation surface, which follows the native window's backing size, or the fullscreen surface, including Retina scaling. Intermediate image sizes never resize the window; instead, a common final fit scales the last processed image to that surface. An explicit resize row at the end of the chain can choose the fitting algorithm, and when its result already matches the surface, no further resize runs.

The **DLSS · 540p + LSFG 4×** preset, for example, downsamples bilinearly to 540p, runs same-size neural rendering, fits the result to the window and generates frames at 4×.

### Adaptive quality

Downsample **Options → Adaptive quality** adjusts the row's working size within the selected scale bounds to stay within a GPU time budget. The saved **Output size** is the baseline, and turning the policy off restores it. Each measurement identifies the completed GPU processing section it covers. If affected provider work runs on a queue that reports no timing, the policy stays pending and its help shows the reason.

File export uses the same policy, with fixed output dimensions and media timestamps. Export timing covers only the processing job, separately from decoding and video encoding.

### Image and scene upscalers

MetalFX Spatial, FSR 1, MAKO, LS1 and the standard filters work on the completed image. FSR 1 has a **Sharpness** control from 0 to 1, and MAKO provides sharpened cubic scaling. Neither needs model files, whereas LS1 uses models imported from [Lossless Scaling](#lossless-scaling-setup).

Temporal upscalers instead reconstruct an image from a scene frame and its history. For this, MetalFX Temporal, FSR 2.2, 3.1 and 4.1, Arm ASR and Snapdragon GSR 2 need matching scene depth, motion and jitter, and providers that use the camera projection also need the game's actual projection metadata. When the graphics processor supports scene-guide normalization, it carries these inputs through known resizes in the chain, including cropped inputs and output-resolution motion. After an unknown coordinate change, however, no matching guides are available. Without a temporal row, the game keeps its original scaler. FSR 3 upscaling and FSR 3 frame generation are separate rows.

Some providers have their own quality controls. FSR 4 **Profile** selects the installed Exact Fast, Lite or Lite 2 shaders, and ASR quality selects its Quality, Balanced, Performance or Ultra Performance shader profile, independently of the input and output resolution. SGSR2 uses the original two-pass reconstruction shaders and converts the game's native motion, camera and exposure data for them. Which providers are available depends on what the graphics processor was built with and which resources are installed. The [provider reference](PROVIDERS.md#scene-temporal-upscaling) lists the inputs of each method.

## Neural models

### Choosing a model

Neural rows run model packages, so each neural row has one **Model** menu, which lists the compatible installed packages and opens model management. A new method can be chosen only when a compatible model is installed. If the model of a saved selection becomes unavailable, the row still shows it, marked **Model needed**, with a link to the model library. A missing model leaves independent effects running; only the automatic input helpers of its row stay pending.

When the menu is set to **Automatic**, the model is chosen in the same order in Simple and Advanced: a compatible preference for that operation, then a compatible existing default, then the recommended download for that operation. Choosing an interpolation default therefore leaves the neural-rendering preference unchanged, and model paths set explicitly for one game are separate from these defaults. For Real-ESRGAN, the recommended download is General with its paired WDN checkpoint. Before the Model menu assigns an imported package to an effect, it checks the package's operation, and imported packages stay available in the shared library for their own operations.

A model's output size follows the selected package; Real-CUGAN's 2×, 3× and 4× variants, for example, share one Model menu. Changing the model therefore refits any input sizing the row set automatically, while explicit processing sizes stay. Shader files selected directly expose their own geometry, inputs and model controls.

Image filters that declare a model dependency, such as Estimated depth fog, use the same **Model** menu. A relative-depth package, for instance, produces a single inferred attachment for the filter that uses it, and this attachment does not provide renderer depth, motion or camera data. Each operation keeps its own model default.

Models are shared across games and selected per row. A model imported during play is available immediately, and a copy in use stays reserved until its game releases it. MetalFX, ordinary shaders and filters without models work regardless of which models are installed.

### Neural methods

DLSS neural rendering blends its result with the input according to **Intensity**, from 0 to 1. Its **Temporal reconstruction** option estimates motion from the images and keeps history; it is separate from renderer-guided temporal upscaling. RTX VSR and the DLSS SR image models produce a 2× image, while Real-ESRGAN and Real-CUGAN keep their model's intrinsic scale and NAFNet restores an image at its original size. For Real-ESRGAN, the denoising strength control appears only when a paired denoising model is installed. MLX interpolation and RIFE generate frames from pairs of images.

History controls depend on the model's operation, and image-only restoration does not request scene guides. The operations on offer depend on the selected provider's compiled support. [Neural models and packages](NEURAL_RESTORATION.md) describes the architectures, and the [provider reference](PROVIDERS.md#neural-rendering-restoration-and-image-upscaling) lists the inputs of each method.

### Model library

Model packages are managed in Runtimes → Effects → **Neural models**. Its table lists the supported download sources and compatible imports with their input and output category, scale, installed state and a help button. Installed models come first, and while any model is installed, sources not yet installed are listed under **More downloads**.

- **Install** and **Download model…** download a listed model.
- **Default for** makes an installed model the preferred one for a named operation. Setting an image-model default leaves the scene-reconstruction and frame-generation preferences unchanged.
- **Use existing package…** uses a prepared package from its current location.
- **Import model…** copies a package into MacLauncher's model storage, or converts compatible raw weights.

Import accepts `.dlssmodel`, `.vsrmodel`, `.srmodel`, `.fgmodel`, `.restorationmodel` and `.depthmodel` packages, compatible raw weights, apps that contain model packages, and ZIP packages. It copies manifests, declared weights and notices without executing anything from the source, and leaves the original package unchanged. Reimporting repairs an incomplete stored copy. Model terms are separate from the provider's source license.

The downloads are:

- the DLSSMac 0.1.6 HT71 neural-rendering model;
- Real-ESRGAN Anime 4×, and Real-ESRGAN General 4× with its paired WDN denoising model;
- Real-CUGAN 2× in Conservative, No denoising and Denoise 1, 2 and 3 variants, and 3× and 4× in Conservative, No denoising and Denoise 3 variants;
- NAFNet SIDD width64 (denoising) and NAFNet GoPro width64 (deblurring);
- RIFE 4.6 and MLX interpolation 310.9.16 for frame generation;
- RTX VSR 1.8.2 2×;
- Depth Anything V2 Small for estimated depth.

Each download is checked against a fixed checksum and keeps its original license notices. From its source archive, the RTX VSR download takes only the model entry and its notices. Import can also convert some original formats: Swift SRVGG tensor names, floating-point ncnn RIFE storage, and the packed weights declared in the supported NVIDIA `.dll` or `.so` library. MacLauncher reads the NVIDIA library as data and never loads or executes it, and compatible Real-CUGAN and NAFNet `.pth` checkpoints import without Python and without running checkpoint code. Conversion changes only model metadata or tensor storage and is separate from GPU image processing. [Neural models and packages](NEURAL_RESTORATION.md#importing-original-checkpoints-and-libraries) describes each conversion.

## Generation and output

### Frame generation

Frame generation inserts images between real frames without changing the game's simulation rate. How many images are added is set by a frame-generation row's **Frame multiplier**, the requested ratio of displayed images to real frames. For LSFG, the multiplier is 2×, 3×, 4× or 5×: 3× requests two generated images per real frame, taking a 30 fps source toward 90 fps. Turning the row off stops generation. LSFG's workload can also be tuned with its Quality or Performance mode, 16-bit or 32-bit precision and motion-estimation scale. For methods that interpolate between two images, such as LSFG, MLX interpolation and RIFE, **Keep static content** returns generated pixels to the real frames wherever both real frames match locally, so interface elements and text stay sharp. This option is off by default for games and on by default for window graphics, and the [provider reference](PROVIDERS.md#static-content) describes its comparison and limits.

Three further methods, VideoToolbox interpolation, MetalFX image interpolation and Vision optical flow, interpolate between two images with frameworks included in macOS, so they need no model files or renderer inputs. VideoToolbox interpolation runs on the Neural Engine at 2× or 4×. MetalFX image interpolation estimates motion from the two images and produces 2×. Vision optical flow warps along Vision's optical flow at 2× to 5× and blends where the flow is unreliable. **Automatic** chooses among these three for each frame: when the method in use falls behind, the row moves to the next method at once, and it returns to a preferred method after ten seconds with time to spare, never sooner than thirty seconds after leaving it. A row that names a method keeps that method. The [provider reference](PROVIDERS.md#image-pair-methods-from-macos-frameworks) lists their sizes, color handling and requirements.

The pacing controls that frame generation shares are in the **Output** section. With **Frame pacing** set to Adaptive, generation varies up to the selected multiplier to approach a **Target frame rate** from 30 to 240 fps, limited by the display's refresh rate. For window graphics, either pacing mode also leaves out any image that no display refresh can show, and image changes are timed to fall between display refreshes, as described in [Timing](FRAME_API.md#timing). **Smooth cadence** favors evenly spaced images. These controls change only the images delivered to the display, never the game's simulation. The main **Motion clarity** control uses the same presentation clock.

LSFG works with native windows, browser surfaces, iOS layers and explicit frame presenters, and it uses opaque frames with display-driven timing. For ordinary 8-bit sRGB input, it uses the original SDR kernels, while HDR and wide-gamut input use the original HDR generation kernel, as described in the [provider reference](PROVIDERS.md#frame-generation). Applications that submit explicit presentation timestamps, however, keep presenting only their real frames. Model selections, scaling and frame-generation controls update during play. The provider reference also lists the other frame-generation methods and the inputs they need.

### Tone mapping

Tone mapping decides how highlights are compressed into the output's range. **Output → Tone mapping** selects Automatic, None, Reinhard or PBR Neutral. Automatic follows the declared range of the image and the output, whereas None skips final highlight compression but still applies the required color and alpha conversion. PBR Neutral needs scene-referred input; with display-referred or already mapped input, it falls back to Automatic, and **Details** shows the reason. Presentation and video export share the same output conversion and dither.

### Compare

To show what the chain changes, **Output → Compare** selects **Source**, a **Source / processed** split or the absolute RGB **Difference**. The source here is the real image handed to the presenter, including any earlier scene reconstruction, and a generated image is compared with the real source image that closes its interval. Both sides enter one linear display-color domain, and the final output conversion and dithering run afterward. File export uses the same saved setting, and the **Divider** and **Difference gain** controls follow the selected mode.

### Motion clarity

**Motion clarity** offers **Auto**, **Off**, **Black frame insertion** and **CRT beam** scheduling, when the presenter supports them. Auto follows a selected subframe shader, and Off overrides that request. The scheduling and illumination are set with **Subframes**, **Visible duty** and **Brightness**, although the result depends on the display's actual refresh rate and presentation.

### Performance overlay, frame-rate cap and presentation

The Output section also holds a performance overlay, a frame-rate cap and two presentation settings. Each setting appears when the graphics processor and the game's frame source support it, or when the saved plan already contains it. An unsupported saved choice remains visible with its reason but is left out of the running plan, while supported changes update during play.

- **Performance overlay** draws frame rates, GPU time, latency, pacing, memory and frame counters over the processed image. **Compact** shows three lines. **Detailed** adds latency parts, memory, the Captured, Presented, Generated, Passthrough and Dropped counters, and each row's measured GPU time; these rows are ordered by section, and rows that share a section's command buffer are marked. [Status and delivery](STATUS_AND_DELIVERY.md#performance-overlay-counters) defines each counter.
- **Frame-rate cap** limits how often the game renders, from 10 to 1000 frames per second. For [window graphics](../game-types/WINDOW.md#graphics), it limits how often frames are taken from the window. Without a cap, MacLauncher never limits the game's rendering.
- **Display sync** and **Drawables** set how processed images are presented. Turning display sync off can lower latency in fullscreen, although it can cause tearing. Two drawables also lower latency, while three keep presentation smoother when GPU time varies.

### Shortcuts and screenshots

**Settings → Launcher** can assign keyboard shortcuts to two graphics actions, **Bypass graphics effects** and **Save processed screenshot**. These shortcuts work from any app while a game runs. When one game is running, they act on that game. With several running, they choose the one whose process or captured app is frontmost, then the one whose process started the frontmost app (such as the wine process of a Wine game), or otherwise the most recently started one. Each shortcut uses Control with at least two of Option, Shift and Command, combinations that macOS and most apps leave free. [Graphics shortcuts](../development/UI_GUIDE.md#graphics-shortcuts) describes the recorder, the refused combinations and the screenshot file names, and [Starting a session](../game-types/WINDOW.md#starting-a-session) describes the window graphics shortcut.

- **Bypass graphics effects** turns the game's graphics off, or back on, exactly like the Graphics checkbox, and saves that choice.
- **Save processed screenshot** saves the game's final image, without the performance overlay, as a PNG file named after the game and the time. The image is processed when graphics processing is on. With processing off or no effect selected, the game's own frame is saved. The file goes to ~/Pictures/MacLauncher or a chosen **Screenshot folder**. An HDR output is saved as a 16-bit HDR PNG in BT.2020 PQ, while a float or 10-bit SDR output is saved as an 8-bit sRGB image.

## Lossless Scaling setup

LS1 (spatial upscaling) and LSFG (frame generation) use models from a purchased copy of [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/). These models are managed in Runtimes → Effects → **Providers**, under **Lossless Scaling**; MetalFX, FSR, sharpened cubic and ordinary shaders work without them. There are four ways to obtain the models:

- **Import Lossless Scaling DLL…** reads a local DLL without executing or changing it, including a copy installed through CrossOver.
- **Find in Steam / CrossOver** searches conventional Steam libraries, recorded Steam libraries, Steam depot downloads and standard CrossOver bottles. The search covers only these local folders; a copy in another location uses Import.
- **Download from Steam…** requests the Windows depot through the installed Mac Steam client and imports its models when the download completes. The signed-in account must own Lossless Scaling. Steam keeps the download. Cancelling stops waiting and skips the automatic import, but a later local search can import the completed download.
- **Use SteamCMD…** is the automatic method that works without Mac Steam. It obtains Valve's macOS SteamCMD and opens Terminal for sign-in and Steam Guard; this sign-in is separate from the Steam app, and Rosetta is requested if needed. The models import automatically, and temporary downloads and sign-in files are removed on completion or cancellation.

With all four, MacLauncher never receives the Steam password or Steam Guard code, and none of them needs Wine. Several imported versions can be installed at once. Their labels include a short hash that tells apart DLLs with the same publisher version, and each game and each effect row can select a different installed version. The first import becomes the default, and later imports keep an explicit default.

Lossless Scaling models are shared across games, and Reload reads them again from local storage. A version imported during play is available immediately, and a copy in use stays reserved until its game releases it. Removing a model keeps the original DLL, and reimporting repairs an incomplete stored copy. Before use, stored copies are verified by SHA-256.

## System requirements

Shared FX and Slang effects and MagpieFX execution run wherever MacLauncher does: macOS 13 or later, on Apple Silicon or Intel. Other providers, such as MLX, libplacebo, ISF, FSR 4.1 and VideoToolbox interpolation, have their own macOS and GPU minimums, which [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) lists. The requirements of the mpv player are in [Video](../game-types/VIDEO.md#mpv-player).
