# Neural models and packages

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

Neural rendering, restoration, super resolution and interpolation run on the shared neural provider, the component that runs neural models on the GPU. This page describes the model architectures it implements, the package formats it reads and the original formats that import converts. The [graphics guide](README.md#neural-models) describes choosing and installing models, and the [provider reference](PROVIDERS.md#neural-rendering-restoration-and-image-upscaling) lists each neural method with its inputs and platform requirements.

[How models run](#how-models-run) · [Restoration and interpolation models](#restoration-and-interpolation-models) · [Model packages](#model-packages) · [Importing original checkpoints and libraries](#importing-original-checkpoints-and-libraries) · [Sources and licenses](#sources-and-licenses)

## How models run

RGB frames enter the provider from retained IOSurfaces. The model operators run on Metal through MLX, and GPU packing writes the result back to the graphics pipeline. An ARM64 helper provides the same operations to translated x86_64 processes. Models are installed separately: installing the provider installs its source notices but no model weights.

The ordered downsample or upscale row before a model determines its input size. The model's output keeps its intrinsic size until a later explicit fitting or downsample row. The selected model supplies that intrinsic output size consistently in both editor views, native preparation and export, and the provider must declare that exact architecture. Per-operation defaults and explicit selections for one effect are independent of each other.

The image models below need no depth or motion from the game engine. RIFE reads a chronological pair of images, and the shared presenter sets the timestamps of the images it generates and schedules their display.

## Restoration and interpolation models

| Method | Architecture | Output |
| --- | --- | --- |
| Real-ESRGAN | SRVGG-16 anime/video or SRVGG-32 general, with per-layer, per-channel PReLU, pixel shuffle and a nearest-neighbor residual | 4× each input dimension |
| Real-CUGAN | Standard UpCunet2x, 3x or 4x: complete-frame cascaded U-Nets, transposed convolutions and global squeeze-excitation means; 4× includes the original residual and pixel-shuffle tail | The selected model's 2×, 3× or 4× scale |
| NAFNet | SIDD width64 denoising or GoPro width64 deblurring, with TLC pooling fixed to the training resolution | Input dimensions |
| RIFE | v4.6 four-stage flow refinement with an explicit interpolation phase and GPU warping | Image-pair dimensions |

Each architecture is implemented and validated separately. RRDB models are a different architecture from SRVGG, Real-CUGAN Pro has its own graph, and NAFNet GoPro and SIDD are separate architectures.

### Real-ESRGAN

SRVGG reconstructs subpixel channels in `(channel, row offset, column offset)` order and adds a nearest-neighbor residual of the input. The general SRVGG-32 model can load its matching WDN checkpoint. `denoiseStrength` then blends the parameters of the two models when the model loads, before inference: 0 selects weak denoising and 1 selects the strong general checkpoint. The control is available only with a compatible paired package and is separate from neural-rendering intensity and output opacity.

### Real-CUGAN and NAFNet

Real-CUGAN computes its attention statistics over complete feature images. NAFNet keeps its trained block counts, channel normalization, residual scales and image padding. NAFNet GoPro uses local pooling kernels derived from the original training resolution, and its spatial reductions accumulate in float32. Independent image tiles cannot replace these attention and pooling domains.

## Model packages

Local `.dlssmodel` packages for neural rendering and `.restorationmodel` packages for restoration keep their manifest, weights, checksums and notices.

A `.restorationmodel` package contains `manifest.json` and compatible safetensors. The manifest identifies the architecture, the RGB input and output format, and the exact tensor names, shapes, dtypes and checksums.

Import validates a model's manifest together with its actual tensor names, dimensions, data types and operation. A display name or a renamed weights file cannot turn one architecture into another. Compatible raw restoration safetensors are recognized by their actual tensor names and shapes and can also be imported. A general SRVGG weights file can be accompanied by the matching `realesr-general-wdn-x4v3.safetensors` or `model-wdn.safetensors` companion in the same folder.

## Importing original checkpoints and libraries

Import converts several original formats into packages. Only model weights are converted, never frames, and the original files and their notices stay unchanged.

### RIFE ncnn folders

A selected RIFE v4.6 folder that contains the original `flownet.param` and floating-point `flownet.bin` is converted during import. Its parameter graph must match the declared source digest.

### Real-CUGAN and NAFNet checkpoints

Original Real-CUGAN UpCunet2x, 3x and 4x checkpoints and the supported NAFNet width64 `.pth` checkpoints import into the same model library. A size-limited data reader accepts legacy and ZIP tensor storage, converts tensor names and convolution and transposed-convolution layouts, and preserves the original floating-point values. Checkpoint globals are read as plain data. Import does not execute Python or checkpoint code and does not require Python to be installed.

### NVIDIA neural-rendering libraries

Original NR libraries that contain `WEIGHTS_HT` or `WEIGHTS_CC_SMALL_FP8` can be imported directly. Import decodes their PE resource data into complete logical NR tensors without loading or executing the DLL. A library that contains both networks supplies two models, HT71 and Small31. Logical NR safetensors can also be imported. Their complete tensor layout, precision and 16-feature to four-channel model structure decide whether they are accepted.

### NVIDIA frame-generation and RTX VSR libraries

The supported original NVIDIA 310.9.16 frame-generation DLL and the Linux RTX VSR 1.8.2 library are converted during import without executing vendor code or requiring Python. Their packed FP16 parameters become the matching interpolation or VSR package.

### DLSS SR captures

DLSS SR uses a prepared preset-K LDR 2× package that contains its reconstruction filter and exact postprocessing shader. Import builds it from a local capture folder containing `libnvidia-ngx-dlss.so.310.7.0`, `L0001_params.bin` and `L0012_params.bin`, and their corresponding `L0001_buf<address>.bin` and `L0012_buf<address>.bin` files. Selecting either the library file or its capture folder starts the same import. The converter verifies the digests of the exact original library, the trained weights and the reconstruction filter, translates the library's reconstruction PTX into a Metal kernel, and then produces the SR package. Import reads these files as data and runs no CUDA or Python code. An NR package cannot supply these resources.

## Sources and licenses

MacLauncher's model downloads include the standard Real-CUGAN scale and noise variants and NAFNet SIDD and GoPro width64. Variants that share an author archive reuse one verified download. An archive published as a GitHub release asset is checked against the size and SHA-256 digest that GitHub currently lists for it, so an archive that the author replaces is still accepted. When the release list cannot be read or no longer lists the archive, it downloads from its address and its SHA-256 is recorded. Only the declared checkpoint is taken from the archive, and it must match its own recorded size and checksum before import. Files addressed by an exact repository commit, and entries read in parts from a published package, are checked against their recorded size and checksum. A file that differs installs nothing, and the error names the file.

[restoration-sources.json](../../src/modules/shared/reshade/neural/native/restoration-sources.json) lists the exact graph sources, revisions and license notices. Model weights and their terms are separate from the provider's source licenses.
