// One reading of an installed runtime row, shared by Runtimes, the inspector and
// the install action. A row that is not ready needs repair when installing its
// version again can fix it. It is incompatible when its package lacks what this
// launcher requires. It is unavailable when this Mac cannot run its build or
// macOS requirement, or when its files are a registration outside MacLauncher's
// runtime storage, which an installation cannot replace.
export function installedRuntimeAvailability(row) {
  if (!row || typeof row !== "object") return null;
  if (row.ready !== false) return "installed";
  if (row.external || row.architectureSupported === false || row.status === "unsupported-host") return "unavailable";
  return INCOMPATIBLE.includes(row.status) ? "incompatible" : "needsRepair";
}
// "unsupported-package": the listed package of the version is this same copy.
const INCOMPATIBLE = ["incompatible", "unsupported-package"];

// A copy that installing its version again may remove: one that needs repair or
// whose version lists a different package, is removable and was not included
// with the app.
export function installedRuntimeReplaceable(row) {
  return (installedRuntimeAvailability(row) === "needsRepair" || row?.status === "incompatible") && row.readOnly !== true &&
    row.removable !== false && row.included !== true && row.bundledExecution !== "direct";
}
