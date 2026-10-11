// Module hooks receive UI services from their host through context.ui. Importing
// or using a module from Node must never load Electron or open UI implicitly.
const HEADLESS_UI = Object.freeze({
  shell: Object.freeze({
    showItemInFolder() {
      throw new Error(
        "Cannot reveal files without UI services. Provide context.ui.shell.showItemInFolder or open the path manually."
      );
    }
  }),
  dialog: Object.freeze({
    showOpenDialog() {
      throw new Error(
        "Cannot select files without UI services. Pass payload.filePaths or provide context.ui.dialog.showOpenDialog."
      );
    },
    showMessageBox(options) {
      const message = options?.message ? `${options.message} ` : "";
      throw new Error(
        `${message}Cannot prompt without UI services. Install the required runtime or tool explicitly before retrying, or provide context.ui.dialog.showMessageBox.`
      );
    }
  }),
  // Icon conversion is optional; callers may continue without a converted icon.
  nativeImage: null
});

function getUiServices(context) {
  return context?.ui || HEADLESS_UI;
}

module.exports = { getUiServices };
