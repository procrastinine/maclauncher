import React from "react";
import ReactDOM from "react-dom/client";
import UtilityApp from "./ui/UtilityApp";
import "./ui/styles.css";

performance.mark("launcher:entry-loaded");
ReactDOM.createRoot(document.getElementById("root")!).render(<UtilityApp />);
