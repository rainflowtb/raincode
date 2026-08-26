/**
 * Floating overlay scrollbars for elements marked with `data-overlay-scroll`.
 *
 * Why not native: on macOS, Chromium only uses zero-gutter overlay scrollbars
 * when no classic mouse is attached AND the page never styles
 * `::-webkit-scrollbar`. This shell fails both, so native bars always reserve
 * 11–15px of layout width. globals.css therefore hides native bars entirely
 * (width 0) and this module draws a fixed-position thumb that floats over the
 * content — visible while hovering or scrolling, draggable, zero gutter.
 *
 * One owner: this module is the only place that creates/positions thumbs.
 * Containers opt in with the `data-overlay-scroll` attribute; discovery and
 * cleanup run through a single MutationObserver started by initOverlayScrollbars().
 *
 * `data-overlay-scroll="gutter"` parks the thumb just right of the container's
 * edge (desktop layout only). Used by the session sidebar: its rows paint flush
 * to the right edge and the sidebar stacking context (z 200) covers the
 * body-level thumb (z 65), so the thumb lives in the 8px seam gutter instead.
 *
 * `data-overlay-scroll-inset-bottom="<px>"` / `data-overlay-scroll-inset-top="<px>"`
 * shorten the thumb's track so it stays inside the visible region of containers
 * whose edges are covered or clipped: the chat composer floats over the
 * transcript's tail, and the shell panel's 16px rounded corners cut into the
 * track's top-right corner.
 */

const SCROLL_ATTR = "data-overlay-scroll";
const INSET_BOTTOM_ATTR = "data-overlay-scroll-inset-bottom";
const INSET_TOP_ATTR = "data-overlay-scroll-inset-top";
const HIDE_DELAY_MS = 900;
const MIN_THUMB_PX = 24;
const THUMB_WIDTH_PX = 4;
const THUMB_INSET_PX = 2;
const GUTTER_GAP_PX = 2;

// Matches the desktop sidebar media query in globals.css — the seam gutter only
// exists there; on mobile the gutter mode falls back to inside placement.
let desktopMedia: MediaQueryList | null = null;
function isDesktopLayout(): boolean {
  desktopMedia ??= window.matchMedia("(min-width: 641px)");
  return desktopMedia.matches;
}

interface Attachment {
  el: HTMLElement;
  thumb: HTMLDivElement;
  update: () => void;
  detach: () => void;
}

let observer: MutationObserver | null = null;
const attachments = new Map<HTMLElement, Attachment>();

function attach(el: HTMLElement): Attachment {
  const thumb = document.createElement("div");
  thumb.className = "overlay-scrollbar-thumb";
  document.body.appendChild(thumb);

  let hovered = false;
  let dragging = false;
  let visible = false;
  let wantVisible = false;
  // True while an ancestor clips the container (sidebar width/translate
  // collapse) or it is off-viewport. The container's own size does not change
  // in those cases, so ResizeObserver never fires — without this the thumb
  // would linger at its last position until the 900ms hide timer expires.
  let occluded = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId = 0;

  const setVisible = (next: boolean) => {
    wantVisible = next;
    const shown = next && !occluded;
    if (visible === shown) return;
    visible = shown;
    thumb.classList.toggle("is-visible", shown);
  };

  const scheduleHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!hovered && !dragging) setVisible(false);
    }, HIDE_DELAY_MS);
  };

  const update = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!el.isConnected) {
        detach();
        return;
      }
      const rect = el.getBoundingClientRect();
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 1 || rect.width === 0 || rect.height === 0) {
        setVisible(false);
        return;
      }
      const insetBottom = Number(el.getAttribute(INSET_BOTTOM_ATTR)) || 0;
      const insetTop = Number(el.getAttribute(INSET_TOP_ATTR)) || 0;
      const trackTop = rect.top + insetTop;
      const trackH = rect.height - insetTop - insetBottom;
      if (trackH <= MIN_THUMB_PX) {
        setVisible(false);
        return;
      }
      const thumbH = Math.max(MIN_THUMB_PX, (trackH * el.clientHeight) / el.scrollHeight);
      const travel = trackH - thumbH;
      const top = trackTop + (el.scrollTop / overflow) * travel;
      const inGutter = el.getAttribute(SCROLL_ATTR) === "gutter" && isDesktopLayout();
      const left = inGutter ? rect.right + GUTTER_GAP_PX : rect.right - THUMB_WIDTH_PX - THUMB_INSET_PX;
      thumb.style.top = `${Math.round(top)}px`;
      thumb.style.left = `${Math.round(left)}px`;
      thumb.style.height = `${Math.round(thumbH)}px`;
      if (hovered || dragging) setVisible(true);
    });
  };

  const flash = () => {
    update();
    setVisible(true);
    scheduleHide();
  };

  const onScroll = () => flash();
  const onEnter = () => {
    hovered = true;
    update();
    setVisible(true);
  };
  const onLeave = () => {
    hovered = false;
    if (!dragging) scheduleHide();
  };

  const onThumbDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    thumb.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    const rect = el.getBoundingClientRect();
    const thumbH = thumb.getBoundingClientRect().height;
    const trackH = rect.height
      - (Number(el.getAttribute(INSET_TOP_ATTR)) || 0)
      - (Number(el.getAttribute(INSET_BOTTOM_ATTR)) || 0);
    const ratio = (el.scrollHeight - el.clientHeight) / Math.max(1, trackH - thumbH);
    const onMove = (ev: PointerEvent) => {
      el.scrollTop = startScroll + (ev.clientY - startY) * ratio;
    };
    const onUp = () => {
      dragging = false;
      thumb.removeEventListener("pointermove", onMove);
      thumb.removeEventListener("pointerup", onUp);
      thumb.removeEventListener("pointercancel", onUp);
      scheduleHide();
    };
    thumb.addEventListener("pointermove", onMove);
    thumb.addEventListener("pointerup", onUp);
    thumb.addEventListener("pointercancel", onUp);
    setVisible(true);
  };

  const resizeObserver = new ResizeObserver(update);
  resizeObserver.observe(el);
  // Ancestor clip / off-viewport detection (sidebar collapse, drawer slide-out).
  // threshold [0, 1]: fire when fully hidden or fully revealed.
  const visibilityObserver = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    const next = !entry.isIntersecting || entry.intersectionRatio < 1;
    if (next === occluded) return;
    occluded = next;
    // Re-evaluate through setVisible so a pending hover/flash request is
    // honored the moment the container is fully visible again.
    setVisible(wantVisible);
    if (!occluded) update();
  }, { threshold: [0, 1] });
  visibilityObserver.observe(el);
  // Content growth without a scroll event (streaming output, lazy rows) still
  // needs a thumb re-layout; childList flaps are cheap enough to observe.
  const contentObserver = new MutationObserver(update);
  contentObserver.observe(el, { childList: true, subtree: true });

  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);
  thumb.addEventListener("pointerdown", onThumbDown);
  thumb.addEventListener("pointerenter", onEnter);
  thumb.addEventListener("pointerleave", onLeave);
  window.addEventListener("resize", update);

  const detach = () => {
    if (hideTimer) clearTimeout(hideTimer);
    if (rafId) cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    contentObserver.disconnect();
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
    thumb.removeEventListener("pointerdown", onThumbDown);
    thumb.removeEventListener("pointerenter", onEnter);
    thumb.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("resize", update);
    thumb.remove();
    attachments.delete(el);
  };

  const attachment: Attachment = { el, thumb, update, detach };
  attachments.set(el, attachment);
  update();
  return attachment;
}

function scan(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(`[${SCROLL_ATTR}]`) && !attachments.has(root)) {
    attach(root);
  }
  for (const el of root.querySelectorAll?.(`[${SCROLL_ATTR}]`) ?? []) {
    if (el instanceof HTMLElement && !attachments.has(el)) attach(el);
  }
}

/** Start watching the document for [data-overlay-scroll] containers. Idempotent. */
export function initOverlayScrollbars(): void {
  if (observer || typeof document === "undefined") return;
  scan(document.body);
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
        const el = mutation.target;
        if (mutation.attributeName === INSET_BOTTOM_ATTR || mutation.attributeName === INSET_TOP_ATTR) {
          attachments.get(el)?.update();
          continue;
        }
        if (el.hasAttribute(SCROLL_ATTR)) {
          if (!attachments.has(el)) attach(el);
        } else {
          attachments.get(el)?.detach();
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) scan(node);
      }
      if (mutation.removedNodes.length > 0) {
        for (const [el, attachment] of attachments) {
          if (!el.isConnected) attachment.detach();
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [SCROLL_ATTR, INSET_BOTTOM_ATTR, INSET_TOP_ATTR],
  });
}
