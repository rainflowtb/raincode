/**
 * Desktop SPA entry — same AppShell as web, no Next.js runtime.
 *
 * Pathname branch: `/collab/<token>` renders the read-only shared-session
 * viewer instead of the app shell. The SPA has no router (URL state lives in
 * the query string), and this is what makes shared read-only links openable
 * for LAN browsers when LAN access is enabled.
 */
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/AppShell";
import "@/app/globals.css";
import "@/app/mobile.css";

// Collab links are rare; importing the viewer eagerly drags the whole
// markdown/message-render stack into the first-paint chunk.
const CollabViewer = lazy(() =>
  import("@/components/CollabViewer").then((m) => ({ default: m.CollabViewer })),
);

const el = document.getElementById("root");
if (!el) {
  throw new Error("#root missing");
}

const collabMatch = /^\/collab\/([^/?#]+)/.exec(window.location.pathname);

createRoot(el).render(
  <StrictMode>
    <Suspense fallback={null}>
      {collabMatch ? <CollabViewer token={decodeURIComponent(collabMatch[1])} /> : <AppShell />}
    </Suspense>
  </StrictMode>,
);
