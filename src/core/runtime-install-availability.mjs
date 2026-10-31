// One reading of an installed runtime row, shared by Runtimes, the inspector and
// the install action. A row that is not ready needs repair when installing its
// version again can fix it. It is unavailable when this Mac cannot run its build
// or macOS requirement, or when its files are a registration outside
// MacLauncher's runtime storage, which an installation cannot replace.
export function installedRuntimeAvailability(row) {
  if (!row || typeof row !== "object") return null;
  if (row.ready !== false) return "installed";
  return row.external || row.architectureSupported === false || row.status === "unsupported-host" ? "unavailable" : "needsRepair";
}

// A copy that installing its version again may remove: one that needs repair,
// is removable and was not included with the app.
export function installedRuntimeReplaceable(row) {
  return installedRuntimeAvailability(row) === "needsRepair" && row.readOnly !== true && row.removable !== false &&
    row.included !== true && row.bundledExecution !== "direct";
}
