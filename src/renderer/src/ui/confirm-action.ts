import type { ConfirmActionRequest } from "./types";

// Confirmations use the native alert with Cancel and a verb button. Without the
// launcher bridge (tests and browser previews) the standard prompt stands in.
export async function confirmAction(request: ConfirmActionRequest): Promise<boolean> {
  const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
  if (typeof api?.confirmAction === "function") return await api.confirmAction(request) === true;
  if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
  return window.confirm([request.message, request.detail].filter(Boolean).join(" "));
}
