export function nextInspectorSelection(selectedGamePath: string | null, inspectorOpen: boolean, gamePath: string) {
  return { selectedGamePath: gamePath, inspectorOpen: selectedGamePath === gamePath ? !inspectorOpen : true };
}

export function gameRowSelectionAction(options: { selectionMode: boolean; selectionDisabled: boolean; metaKey: boolean; shiftKey: boolean }) {
  if (options.selectionMode && options.selectionDisabled) return { kind: "none" as const };
  if (options.selectionMode || options.metaKey) return { kind: "toggle" as const, range: options.shiftKey };
  return { kind: "inspect" as const };
}
