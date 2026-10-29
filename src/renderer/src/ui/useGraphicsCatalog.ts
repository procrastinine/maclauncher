import {useEffect, useSyncExternalStore} from "react";
import type {GraphicsCatalogEvent, ReShadeState} from "./types";

// The graphics catalog of this window. Views that show it declare demand while
// they are open; the main process builds it only while some view asks, and
// sends each new revision to open views. The last value is kept for a view
// that opens again, which receives only a newer revision.
let catalog: ReShadeState | undefined, revision: number | null = null, demand = 0, request = 0, unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
const api = () => typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;

function accept(event: GraphicsCatalogEvent | undefined) {
  if (!event || event.revision == null || event.revision === revision && !event.reshade) return;
  if (event.reshade) catalog = event.reshade;
  revision = event.revision;
  for (const listener of listeners) listener();
}
function acquire() {
  const launcher = api();
  if (!launcher?.requestGraphicsCatalog || demand++ > 0) return;
  unsubscribe ||= launcher.onGraphicsCatalog?.(accept);
  const token = ++request;
  launcher.requestGraphicsCatalog({open: true, revision}).then(event => {if (token === request) accept(event);}, () => {});
}
function release() {
  const launcher = api();
  if (!launcher?.requestGraphicsCatalog || --demand > 0) return;
  request++;
  void launcher.requestGraphicsCatalog({open: false}).catch(() => {});
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {listeners.delete(listener);};
}

/** The graphics catalog while `open`; undefined until it arrives or when closed. */
export function useGraphicsCatalog(open: boolean): ReShadeState | undefined {
  const value = useSyncExternalStore(subscribe, () => catalog, () => undefined);
  useEffect(() => {
    if (!open) return;
    acquire();
    return release;
  }, [open]);
  return open ? value : undefined;
}
