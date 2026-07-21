import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { disposeRealtimeClient } from "./client.js";

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><App /></StrictMode>);

if (import.meta.hot) import.meta.hot.dispose(() => {
  root.unmount();
  void disposeRealtimeClient();
});
