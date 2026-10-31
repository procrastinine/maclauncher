// Keep the generated state as one cacheable data asset shared by the demo views.
const response = await fetch(new URL("../data/state.json", import.meta.url));
if (!response.ok) throw new Error(`Demo state returned HTTP ${response.status}.`);
export const demoData = await response.json();
