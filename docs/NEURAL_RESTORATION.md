# Neural restoration models

Restoration and interpolation use the shared GPU neural provider. RGB frames enter from retained IOSurfaces, model operators run on Metal through MLX, and GPU packing writes the result back to the graphics pipeline. The ARM64 helper provides the same operations to translated x86_64 processes. Models are separate local inputs; provider installation contains source notices without model weights.

| Method | Model contract | Output |
| --- | --- | --- |
| Real-ESRGAN | SRVGG-16 anime/video or SRVGG-32 general; per-layer, per-channel PReLU | 4× each input dimension |
| Real-CUGAN | Standard UpCunet2x/3x/4x; complete-frame cascaded U-Nets and global squeeze-excitation means | Selected model's 2×, 3× or 4× scale |
| NAFNet | SIDD width64 denoising or GoPro width64 deblurring with fixed training-resolution TLC pooling | Input dimensions |
| RIFE | v4.6 four-stage flow refinement with explicit interpolation phase | Image-pair dimensions |

An ordered downsample or upscale row determines the model input extent. Model output retains its intrinsic size until a later explicit fitting or downsample row. These image models require no engine depth or motion inputs. RIFE consumes a chronological image pair; the shared presenter owns its generated timestamps and display scheduling.

SRVGG reconstructs subpixel channels in `(channel, row offset, column offset)` order and adds a nearest-neighbor input residual. General SRVGG-32 optionally loads its matching WDN checkpoint. `denoiseStrength` blends matching model parameters before inference: zero selects weak denoising and one selects the strong general checkpoint. This control is separate from neural-rendering intensity and is available only with the paired checkpoints.

Real-CUGAN computes attention statistics over complete feature images. NAFNet preserves its trained block counts, channel normalization, residual scales and image padding. GoPro uses local pooling kernels derived from the original training resolution; its spatial reductions accumulate in float32. Independent image tiles do not replace these attention domains.

Local `.restorationmodel` packages contain `manifest.json` and compatible safetensors. The manifest identifies the architecture, RGB input/output contract, exact tensor names, shapes, dtypes and checksums. Compatible raw safetensors can also be imported. A general SRVGG weights file can include the matching `realesr-general-wdn-x4v3.safetensors` or `model-wdn.safetensors` companion in the same folder. A selected RIFE v4.6 folder containing its original `flownet.param` and floating-point `flownet.bin` is converted during import; the parameter graph must match the declared source digest. Conversion handles model weights only. Original files and accompanying notices remain unchanged.

Original Real-CUGAN UpCunet2x/3x/4x and supported NAFNet width64 `.pth` checkpoints use
the same model library. A bounded data reader accepts legacy and ZIP tensor
storage, converts convolution and transposed-convolution layouts, and preserves
the original floating-point values. Checkpoint globals remain inert metadata;
Python and checkpoint code are not executed. The declared download sources
include the standard Real-CUGAN scale/noise variants and NAFNet SIDD and GoPro
width64. Variants sharing an author archive reuse one verified download.
Per-operation defaults and explicit per-effect selections remain independent.
The selected model supplies the intrinsic output size in both editor views,
native preparation and export; a provider must declare that exact architecture.

The exact graph sources, revisions and license notices are listed in [restoration-sources.json](../src/modules/shared/reshade/neural/native/restoration-sources.json). Model terms apply separately from the provider's source licenses.
