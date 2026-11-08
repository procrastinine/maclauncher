# Renderer integrations

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

Every runtime connects to the [graphics chain](README.md#how-the-chain-works) through a frame adapter, which hands each completed image to MacLauncher's graphics processor. Effects that use only the image therefore work with any adapter. Scene effects, such as depth effects and temporal upscaling, also need matching depth, motion and camera data from the game's renderer. Changing the size the game renders at needs a cooperating renderer or the shared virtual window. Renderer integrations supply that data and control; this page describes which runtimes have them. The [frame-source tables](INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs) cover each route in technical detail.

[Frame adapters](#frame-adapters) · [Scene depth](#scene-depth) · [Temporal upscaling](#temporal-upscaling) · [Godot](#godot) · [CrossOver and Sikarugir](#crossover-and-sikarugir)

## Frame adapters

Which frame adapter a game uses depends on how it draws. Games that draw through native Metal, hardware OpenGL or Core Animation use the shared window adapter, while browser hosts, iOS layers and runtimes that submit their own textures each use a dedicated adapter; runtimes of the last kind use the [frame APIs](FRAME_API.md#borrowed-frames-and-owned-presentation). With every adapter, the pipeline keeps textures on the GPU and preserves the game's native window, resizing and fullscreen controls. Completed Quartz bitmaps are uploaded to the GPU once, before processing. Module authors declare an adapter as described in [runtime and frame adapters](PIPELINE.md#runtime-and-frame-adapters).

## Scene depth

Depth effects use the depth texture that belongs to the displayed image, and where that texture comes from depends on the adapter. With native Metal, the adapter captures a stored, shader-readable depth attachment from the same command buffer, and with hardware OpenGL, it uses the window's depth buffer. A renderer that discards depth, or keeps it in a separate scene path, instead needs an explicit depth integration, which submits depth alongside color through the [frame APIs](FRAME_API.md#borrowed-frames-and-owned-presentation).

Depth effects also follow the game's projection, reverse-Z, logarithmic-depth and orientation settings. The game's own definitions are held in the editor's [Depth input](README.md#shader-files-and-parameters) settings, although custom ReShade effects can override the compiler's forward-depth definitions.

## Temporal upscaling

Temporal upscaling rows use matching scene inputs, which the active renderer integration supplies. Native MetalFX integrations and the shared temporal frame API provide them directly, and the integrations below do so for Godot games and for Windows games under CrossOver and Sikarugir. Other engines can also deliver the same scene data through their own adapters. The [provider reference](PROVIDERS.md#scene-temporal-upscaling) lists the inputs each method needs.

## Godot

For Godot games, render-size control and scene inputs come from a Godot helper that MacLauncher adds to the launch. This helper is loaded only when a launch's saved plan reads scene inputs or changes **Game resolution**, and other launches start the original project or pack instead. [Godot graphics](../game-types/GODOT.md#graphics) describes that launch route.

Through the helper, MacLauncher's Godot adapter supports **Game resolution** by changing the root 3D render scale when the game uses the Forward+ or Mobile renderer outside XR. The window drawable and the 2D interface keep their size, and a game that uses the Compatibility renderer keeps its existing scale.

**Source filter** chooses Game original, Bilinear, MetalFX Spatial or FSR 1 for the 3D scene before the interface is composed. However, while Godot's temporal integration controls the source scaler, source filtering uses Game original.

For temporal upscaling, the Godot Metal compositor supplies its actual root-scene textures through the shared scene API. A perspective projection adds near-plane, far-plane and field-of-view metadata, but the depth and motion data are submitted with or without that optional camera description. Camera preparation keeps the game's render scale. The helper also declares how it handles the Compatibility renderer, viewport selection and multiview.

## CrossOver and Sikarugir

For Windows games, [CrossOver](../runtimes/CROSSOVER.md) and [Sikarugir](../runtimes/SIKARUGIR.md) can forward scene inputs from a game's DLSS calls through compatible DXMT or D3DMetal NVAPI/NGX integrations. Selecting a shared temporal method prepares the integration at launch; alternatively, the runtime setting **Game temporal integration** requests MetalFX Temporal with the runtime's own DXMT or D3DMetal, and a DXMT or D3DMetal version from Runtimes enables the integration by itself. DXVK and vkd3d-proton forward a game's DLSS frames without either, when the game's Vulkan driver carries temporal frames, as [DLSS through Vulkan translators](INPUTS_AND_ADAPTERS.md#dlss-through-vulkan-translators) describes. The game controls the temporal render resolution. A shared provider replaces the native scaler only when matching scene resources and all of that provider's required inputs are available; otherwise the integration keeps the game's original scaler. Camera-dependent methods, including FSR 2 and FSR 3, also need actual camera parameters from a compatible Streamline integration. A DLSS call alone supplies no camera parameters, and a Direct3D 11 game that does not use Streamline supplies none through this route.

Once a scene connection exists, compatible providers and their settings change live over it. Choosing a different algorithm therefore needs no relaunch, although switching to a different game-facing interception API can require relaunching the game.
