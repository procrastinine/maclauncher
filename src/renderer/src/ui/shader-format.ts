import type { ShaderFormat, ShaderTraits } from "./types";

export const shaderFamilies = [{ id: "reshade", label: "ReShade" }, { id: "libretro", label: "libretro" }, { id: "mpv", label: "MPV" }] as const;
export type ShaderFamily = typeof shaderFamilies[number]["id"];
export function shaderFamily(format?: ShaderFormat | null): ShaderFamily | null {
  return format === "fx" ? "reshade" : format === "slangp" || format === "slang" ? "libretro" : format === "libplacebo" ? "mpv" : null;
}

export function shaderFormat(path?: string | null): ShaderFormat | null {
  const extension = path?.match(/\.(fx|slangp|slang|glsl|hook)$/i)?.[1].toLowerCase();
  return extension === "glsl" || extension === "hook" ? "libplacebo" : extension as ShaderFormat || null;
}

export function shaderFormatLabel(format?: ShaderFormat | null): string {
  return format === "fx" ? "ReShade · .fx" : format === "slangp" ? "RetroArch preset · .slangp"
    : format === "slang" ? "RetroArch shader · .slang" : format === "libplacebo" ? "MPV/libplacebo · .glsl / .hook" : "Unsupported format";
}

export function scalingShader(traits?: ShaderTraits | null): boolean {
  return ["upscaling", "downscaling", "scaling"].includes(traits?.category || "") || Boolean(traits?.outputScale || traits?.conditionalGeometry || traits?.displayDependentGeometry || traits?.unresolvedGeometry);
}
export function shaderBehaviorGroup(traits?: ShaderTraits | null): string {
  if (scalingShader(traits)) return traits?.category === "downscaling" ? "Downscaling shaders"
    : traits?.category === "scaling" ? "Resolution-dependent shaders" : traits?.neural ? "Neural upscaling shaders" : "Upscaling shaders";
  return traits?.category === "restoration" ? "Restoration and denoise" : traits?.category === "chroma" ? "Chroma reconstruction"
    : traits?.category === "crt" ? "CRT" : traits?.category === "color" ? "Colour" : "Effects";
}
