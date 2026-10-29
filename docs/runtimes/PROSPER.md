# Prosper

Prosper is an optional backend for PS5 games already detected by the launcher. Selecting Prosper retains the imported game type and the existing PS5 inspection and decompilation actions. AnyPS5 remains the default backend.

Prosper runs a 64-bit Intel macOS executable under Rosetta on Apple Silicon. A compatible Vulkan 1.4 runtime is selected through the **Vulkan** setting in Prosper Settings and in each game's runtime settings, which lists installed implementations without a network request; Automatic prefers the managed KosmicKrisp provider. **Frame rate** shows the runtime's frame-rate display.

The Runtimes view accepts a local Prosper executable, app bundle or complete runtime directory. Local builds retain their exact source revision in the runtime manifest. The current upstream source provides no license grant, so no redistributable macOS package is offered.

Play stages the original PS5 executable, modules, metadata and assets in the game's private Prosper directory. Original files and AnyPS5 preparation remain unchanged. Prosper saves use separate per-game storage, with a further title namespace maintained by the runtime. An explicit save-location override remains available.

The corresponding local build recipe and exact source/dependency pins live in MacLauncher Builds under `producers/prosper/`. No compiler or SDK is needed to launch an already built local runtime. The launcher does not decrypt encrypted PS5 content.

Upstream: [mattias800/prosper](https://github.com/mattias800/prosper).
