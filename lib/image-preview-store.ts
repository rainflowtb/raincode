/**
 * Shared open-state of full-screen image previews (PreviewableImage lightboxes
 * portaled to document.body). AppShell-level state (viewerFile/settings) cannot
 * see these local overlays, but the pooled native browser view must detach
 * while ANY overlay covers it — it paints above the DOM by design. Refcounted:
 * only the 0↔open transition notifies.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let openCount = 0;

export function subscribeImagePreviewOverlay(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getImagePreviewOverlayOpen(): boolean {
  return openCount > 0;
}

export function setImagePreviewOverlay(open: boolean): void {
  const next = Math.max(0, openCount + (open ? 1 : -1));
  if (next === openCount) return;
  openCount = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* ignore */ }
  }
}
