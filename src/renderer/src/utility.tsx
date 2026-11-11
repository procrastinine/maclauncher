performance.mark("launcher:shell-entry");
const api = window.MacLauncher?.launcher;
const state = Promise.resolve().then(() => api?.initialStateReady?.());
void Promise.all([import("react"), import("react-dom/client"), import("./ui/UtilityApp"), import("./ui/styles.css"), state])
  .then(([React, ReactDOM, {default: UtilityApp}]) => {
    performance.mark("launcher:entry-loaded");
    ReactDOM.createRoot(document.getElementById("root")!).render(React.createElement(UtilityApp));
  }).catch(error => {
    console.error(error);
    const notice = document.getElementById("utility-error");
    if (notice) { notice.hidden = false; notice.textContent = "Could not load this view."; }
  });
