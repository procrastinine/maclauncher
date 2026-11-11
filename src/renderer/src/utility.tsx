performance.mark("launcher:shell-entry");
const api = window.MacLauncher?.launcher;
// Start the independent refill's control graph and state together; its HTML
// shell can paint while those asynchronous requests are in flight.
void Promise.all([import("react"), import("react-dom/client"), import("./ui/UtilityApp"), import("./ui/styles.css"), api?.initialStateReady?.()])
  .then(([React, ReactDOM, {default: UtilityApp}]) => {
    performance.mark("launcher:entry-loaded");
    ReactDOM.createRoot(document.getElementById("root")!).render(React.createElement(React.Suspense, {fallback: null}, React.createElement(UtilityApp)));
  }).catch(error => {
    console.error(error);
    const notice = document.getElementById("utility-error");
    if (notice) { notice.hidden = false; notice.textContent = "Could not load this view."; }
  });
