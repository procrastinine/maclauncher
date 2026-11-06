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

Labels use the CPU vocabulary in [Processor builds](README.md#processor-builds).

- In **Runtimes**, the **DirectX → Vulkan**, **DirectX → Metal** and **Vulkan drivers** entries mark every installed version with its build, from the CPU slices of its installed library, and both builds of one version appear as two rows.
- For CrossOver and Sikarugir games, the inspector's **Vulkan** row ends with the build that the Wine process loads, taken from the same inspected Wine layout that Play prepares translator files for: **Intel (Rosetta)** for Intel Wine on Apple Silicon, including CrossOver's Intel Wine, **Intel** on an Intel Mac and **Apple Silicon** for ARM64 Wine, including the CrossOver 27 FEX preview. Direct3D rows name Windows libraries and carry no Mac CPU.
- The Vulkan driver choices of a game share the build of their consumer, Intel for AnyPS5 and Prosper and Apple Silicon for Android, so the menu does not repeat it. The choice list checks each library for that CPU, the same check that selects the library at launch.
- Each installed version of a driver package is one choice for a consumer, even when both of its CPU builds are installed.
