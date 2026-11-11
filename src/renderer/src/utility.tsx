performance.mark("launcher:shell-entry");
const api = window.MacLauncher?.launcher;
// The refill shares a warm renderer. Paint its shell before the controls can
// occupy that renderer and delay another native window's presentation.
void new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  .then(() => Promise.all([import("react"), import("react-dom/client"), import("./ui/UtilityApp"), import("./ui/styles.css"), api?.initialStateReady?.()]))
  .then(([React, ReactDOM, {default: UtilityApp}]) => {
    performance.mark("launcher:entry-loaded");
    ReactDOM.createRoot(document.getElementById("root")!).render(React.createElement(UtilityApp));
  }).catch(error => {
    console.error(error);
    const notice = document.getElementById("utility-error");
    if (notice) { notice.hidden = false; notice.textContent = "Could not load this view."; }
  });
