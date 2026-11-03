# Renderer integrations

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

Every runtime connects to the [graphics chain](README.md#how-the-chain-works) through a frame adapter, which hands each completed image to MacLauncher's graphics processor. Effects that use only the image work with any adapter. Scene effects, such as depth effects and temporal upscaling, also need matching depth, motion and camera data from the game's renderer. Changing the size the game renders at needs a cooperating renderer or the shared virtual window. Renderer integrations supply that data and control; this page describes which runtimes have them. The [frame-source tables](INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs) cover each route in technical detail.

[Frame adapters](#frame-adapters) · [Scene depth](#scene-depth) · [Temporal upscaling](#temporal-upscaling) · [Godot](#godot) · [CrossOver and Sikarugir](#crossover-and-sikarugir)

## Frame adapters

Games that draw through native Metal, hardware OpenGL or Core Animation use the shared window adapter. Browser hosts, iOS layers and runtimes that submit their own textures each use a dedicated adapter. The pipeline keeps textures on the GPU and preserves the game's native window, resizing and fullscreen controls. Completed Quartz bitmaps are uploaded to the GPU once, before processing. Runtimes that submit their own textures use the [frame APIs](FRAME_API.md#borrowed-frames-and-owned-presentation), and module authors declare an adapter as described in [runtime and frame adapters](PIPELINE.md#runtime-and-frame-adapters).

## Scene depth

Depth effects use the depth texture that belongs to the displayed image. With native Metal, the adapter captures a stored, shader-readable depth attachment from the same command buffer. With hardware OpenGL, it uses the window's depth buffer. A renderer that discards depth, or keeps it in a separate scene path, needs an explicit depth integration, which submits depth alongside color through the [frame APIs](FRAME_API.md#borrowed-frames-and-owned-presentation).

The projection, reverse-Z, logarithmic-depth and orientation settings of depth effects follow the game. Custom ReShade effects can override the compiler's forward-depth definitions; the editor's [Depth input](README.md#shader-files-and-parameters) settings hold the game's own definitions.

## Temporal upscaling

Temporal upscaling rows use the matching scene inputs that the active renderer integration supplies. Native MetalFX integrations and the shared temporal frame API supply them directly. The integrations below supply them for Godot games and for Windows games under CrossOver and Sikarugir. Other engines can supply the same scene data through their own adapters. The [provider reference](PROVIDERS.md#scene-temporal-upscaling) lists the inputs each method needs.

## Godot

MacLauncher's Godot adapter supports **Game resolution** by changing the root 3D render scale when the game uses the Forward+ or Mobile renderer outside XR. The window drawable and the 2D interface keep their size. A game that uses the Compatibility renderer keeps its existing scale.

**Source filter** chooses Game original, Bilinear, MetalFX Spatial or FSR 1 for the 3D scene before the interface is composed. While Godot's temporal integration controls the source scaler, source filtering uses Game original.

The Godot Metal compositor supplies its actual root-scene textures through the shared scene API. A perspective projection adds near-plane, far-plane and field-of-view metadata; the depth and motion data are submitted with or without that optional camera description. The Godot helper declares how it handles the Compatibility renderer, viewport selection and multiview. Camera preparation keeps the game's render scale.

The helper is loaded only for a launch whose saved plan reads scene inputs or changes **Game resolution**; other launches start the original project or pack. [Godot graphics](../game-types/GODOT.md#graphics) describes that launch route.

## CrossOver and Sikarugir

[CrossOver](../runtimes/CROSSOVER.md) and [Sikarugir](../runtimes/SIKARUGIR.md) connect a game's DLSS support to the shared temporal upscalers through DXMT or D3DMetal NVAPI/NGX integration. Selecting a shared temporal method enables this integration at launch, and the game's DLSS option then supplies the scene inputs. The runtime setting **Game temporal integration** enables it with MetalFX Temporal, and the method can later be changed live. Both routes run the selected Metal scaler. The included DXMT camera integration supplies Streamline camera constants when the matching DXMT components are present. The game controls the temporal render resolution.

Compatible providers and their settings change live over an existing scene connection. Switching to a different game-facing interception API can require relaunching the game; choosing a different algorithm does not.
