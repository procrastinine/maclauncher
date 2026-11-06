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
