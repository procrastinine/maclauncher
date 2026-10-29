// Renderer confirmations use the native alert: Cancel is the default and the
// cancel response, and the second button names the action ("Forget", "Remove").
function confirmActionOptions(request) {
  const text = (value, limit) => typeof value === "string" && value.trim() && value.length <= limit;
  if (!request || typeof request !== "object" || !text(request.message, 2000) || !text(request.confirmLabel, 64) ||
    request.detail != null && (typeof request.detail !== "string" || request.detail.length > 8000) ||
    request.destructive != null && typeof request.destructive !== "boolean") throw new Error("Invalid confirmation.");
  return { type: request.destructive ? "warning" : "question", buttons: ["Cancel", request.confirmLabel.trim()],
    defaultId: 0, cancelId: 0, noLink: true, message: request.message.trim(), ...(request.detail?.trim() ? { detail: request.detail.trim() } : {}) };
}

function registerConfirmAction({ ipcMain, dialog, BrowserWindow }) {
  ipcMain.handle("launcher:confirmAction", async (event, request) => {
    const options = confirmActionOptions(request);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const { response } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    return response === 1;
  });
}

module.exports = { confirmActionOptions, registerConfirmAction };
