import {libplaceboFilterLabel} from "../../../modules/shared/effects/presentation.mjs";

// These are alternate names in the same libplacebo filter catalog, not
// equivalences between independent native and shared implementations.
const aliases: Record<string, string> = {
  "libplacebo:triangle": "libplacebo:bilinear",
  "libplacebo:ewa_hanning": "libplacebo:ewa_hann"
};

export function spatialMenuMethods(methods: string[], selected?: string): string[] {
  const unique = [...new Set(methods)], available = new Set(unique);
  return unique.filter(method => method === selected ||
    !(aliases[method] && available.has(aliases[method])) && !(selected && aliases[selected] === method));
}

export function spatialMethodLabel(method: string, labels: Record<string, string> = {}, includeProvider = false): string {
  if (!method.startsWith("libplacebo:")) return labels[method] || method;
  const canonical = aliases[method] || method, name = canonical.replace(/^libplacebo:/, "");
  const supplied = labels[canonical] || labels[method];
  const label = libplaceboFilterLabel(name, supplied && supplied !== method && supplied !== method.replace(/^libplacebo:/, "") ? supplied : undefined);
  return label + (includeProvider ? " · libplacebo" : "");
}
