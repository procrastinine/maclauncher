import React from "react";
import { pathDisplayParts } from "./path-display-model";
import "./path-display.css";

// Keep the last component visible while the leading directories give up space.
export function PathDisplay({ path, managed = false }: { path?: string | null; managed?: boolean }) {
  if (!path) return <span>—</span>;
  if (managed) return <span title={path}>Managed by MacLauncher</span>;
  const parts = pathDisplayParts(path);
  return <span className="pathDisplay" title={path} aria-label={path}>
    <span className="pathDisplayPrefix">{parts.prefix}</span><span className="pathDisplayName">{parts.name}</span>
  </span>;
}
