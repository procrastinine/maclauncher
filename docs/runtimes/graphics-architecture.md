# Graphics translator CPU builds

A graphics translator and its Vulkan loader must contain a native CPU slice matching the process that loads them. The Windows game's CPU architecture does not determine the native Wine driver build.

| Consumer | KosmicKrisp build | MoltenVK build | Native process |
| --- | --- | --- | --- |
| CrossOver with Intel Wine | x64 | x64 slice, including universal packages | x64 Wine; Rosetta on Apple Silicon |
| CrossOver with ARM64 Wine, including the CrossOver 27 FEX preview | arm64 | arm64 slice, including universal packages | arm64 Wine; FEX translates Windows code |
| Sikarugir | x64 | x64 slice, including universal packages | x64 Wine; Rosetta on Apple Silicon |
| AnyPS5 | x64 | x64 slice, including universal packages | x64 host; Rosetta on Apple Silicon |
| Prosper | x64 | x64 slice, including universal packages | x64 host; Rosetta on Apple Silicon |
| Android | arm64 | arm64 slice, including universal packages | arm64 JVM or ART host and ANGLE |
| Shared libplacebo effects | — | universal package, matching process slice | arm64 or x64 graphics host |

Wine Vulkan compute helpers use Sikarugir's x64 KosmicKrisp build. The matched Wine Vulkan scene adapter uses an x64 MoltenVK build. Both follow their native Wine host. Shared libplacebo effects link to their packaged MoltenVK library independently of a game's Vulkan driver selection.

Upstream LWJGL KosmicKrisp packages contain arm64 libraries. MacLauncher KosmicKrisp packages provide separate arm64 and x64 builds. A universal MoltenVK library contains both native slices; the loading process selects its matching slice.

## Labels

Runtimes, game settings and the inspector name the CPU build a consumer loads.

- In **Runtimes**, the **DirectX → Vulkan**, **DirectX → Metal** and **Vulkan drivers** entries mark every installed version **x64**, **arm64** or **universal**, from the CPU slices of its installed library, and both builds of one version appear as two rows. [Processor builds](README.md#processor-builds) describes the version and **Build** menus.
- For CrossOver and Sikarugir games, the inspector's **Vulkan** row and the Vulkan driver choices in Runtime Settings end with the build that the Wine process loads, taken from the same inspected Wine layout that Play prepares translator files for: **x64 (Wine under Rosetta)** for Intel Wine on Apple Silicon, **x64** for Intel Wine on an Intel Mac and **arm64 (ARM64 Wine)** for ARM64 Wine, including the CrossOver 27 FEX preview. Direct3D rows name Windows libraries and carry no Mac CPU.
- The Vulkan choices of AnyPS5 and Prosper end with **x64 (under Rosetta)** on Apple Silicon and **x64** on an Intel Mac, and Android's end with **arm64**. These are the builds whose libraries the choice list checked for that CPU, the same check that selects the library at launch. A saved choice that is not installed names no build.
- Each installed version of a driver package is one choice for a consumer, even when both of its CPU builds are installed.
