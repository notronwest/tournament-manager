import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
// Self-hosted brand fonts (issue #735 -- offline mode must never fetch
// fonts.googleapis.com/fonts.gstatic.com). Fontsource ships the actual woff2
// files as package assets, so Vite bundles them locally like any other
// import -- zero CDN requests, works identically online and offline. Weights
// mirror what the old Google Fonts <link> requested.
import "@fontsource/alfa-slab-one/400.css";
import "@fontsource/anton/400.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
// Design tokens first so the custom properties exist before index.css
// (and inline styles) resolve them. Shared vocabulary; see
// ../../wmpc-meta/design-system/.
import "./tokens.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>,
);
