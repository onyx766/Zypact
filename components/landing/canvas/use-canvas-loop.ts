"use client";

import { useEffect, type RefObject } from "react";

/**
 * The render loop shared by the landing page's canvases.
 *
 * A canvas component hands this hook a scene factory; the hook owns everything
 * around the drawing:
 *
 * - backing-store sizing from a ResizeObserver, at the device pixel ratio
 *   capped by `maxDpr` (and by `maxPixels`, so a huge viewport cannot ask for
 *   an enormous bitmap), re-evaluated when the ratio changes (zoom, a move to
 *   another monitor). Resizes are applied at the start of the next frame, so
 *   a window drag costs at most one rebuild per frame;
 * - running only while the canvas is on screen (IntersectionObserver) and the
 *   tab is visible, at no more than `fps` frames per second. Animation time
 *   only advances while running, so a paused scene resumes where it stopped;
 * - `prefers-reduced-motion: reduce`: exactly one static frame, redrawn only
 *   when the canvas resizes. A live change of the preference is honoured;
 * - pointer and scroll state, kept from passive listeners. The canvas rect is
 *   measured only when layout is already clean (in observer callbacks), and
 *   scrolling is applied arithmetically, so frames never read layout;
 * - teardown that is safe under StrictMode's mount, unmount, mount: every
 *   listener, observer and frame request is released, and the scene disposed.
 *
 * Nothing runs during server rendering: all of it lives in an effect. If the
 * browser cannot create a 2D context the hook does nothing and the canvas
 * stays transparent.
 */

export interface CanvasPointer {
  /** Pointer position relative to the canvas centre: -1 at the left edge,
   *  +1 at the right. Not clamped; it exceeds ±1 outside the canvas. */
  x: number;
  /** As `x`, vertically: -1 at the top edge, +1 at the bottom. */
  y: number;
  /** Pointer position in CSS pixels from the canvas's top-left corner. */
  px: number;
  py: number;
  /** A mouse or pen is over the document. Touch never activates it. */
  active: boolean;
  /** The active pointer is within the canvas rectangle. */
  inside: boolean;
}

export interface CanvasScroll {
  /** window.scrollY, from the last scroll event. */
  y: number;
  viewportHeight: number;
  /** The canvas top relative to the viewport, in CSS pixels. */
  top: number;
  /** 0 as the canvas top enters at the viewport bottom, 1 as its bottom
   *  leaves at the top. Fixed canvases report 0.5. */
  progress: number;
}

export interface CanvasSize {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Backing-store pixels per CSS pixel (the capped device pixel ratio). */
  dpr: number;
}

export interface CanvasFrame extends CanvasSize {
  ctx: CanvasRenderingContext2D;
  /** Seconds of animation, advancing only while the loop runs. Under reduced
   *  motion it is pinned to the `staticTime` option. */
  time: number;
  /** Seconds since the previous frame, clamped to 0.1. 0 on a first frame. */
  delta: number;
  pointer: CanvasPointer;
  scroll: CanvasScroll;
  reducedMotion: boolean;
  /** The first frame after a start, a resume or a resize: smoothed values
   *  should snap to their targets instead of easing from stale ones. */
  first: boolean;
}

export interface CanvasEnvironment {
  reducedMotion: boolean;
  /** The primary input cannot hover (touch screens). */
  coarsePointer: boolean;
}

export interface CanvasScene {
  /** Called before the first frame and whenever the backing store changes. */
  resize(size: CanvasSize): void;
  /** Draws one frame. The same frame object is reused every call. */
  render(frame: CanvasFrame): void;
  dispose?(): void;
}

export type CanvasSceneFactory = (
  ctx: CanvasRenderingContext2D,
  env: CanvasEnvironment
) => CanvasScene | null;

export interface CanvasLoopOptions {
  /** Device-pixel-ratio cap. Default 2. */
  maxDpr?: number;
  /** Backing-store pixel budget; the ratio drops below `maxDpr` to fit it. */
  maxPixels?: number;
  /** Frame-rate cap. Default 60. */
  fps?: number;
  /** IntersectionObserver margin: how early the loop starts before the
   *  canvas scrolls into view. Default "160px 0px". */
  rootMargin?: string;
  /** `time` for the reduced-motion frame. Default 0. */
  staticTime?: number;
}

const MAX_DELTA = 0.1;

export function useCanvasLoop(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  createScene: CanvasSceneFactory,
  options: CanvasLoopOptions = {}
): void {
  const {
    maxDpr = 2,
    maxPixels = 0,
    fps = 60,
    rootMargin = "160px 0px",
    staticTime = 0,
  } = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      typeof window === "undefined" ||
      typeof ResizeObserver === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      return undefined;
    }

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d", { alpha: true });
    } catch {
      ctx = null;
    }
    if (!ctx) return undefined;

    const media = (query: string): MediaQueryList | null =>
      typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
    const reduceQuery = media("(prefers-reduced-motion: reduce)");
    const coarseQuery = media("(hover: none) and (pointer: coarse)");
    let reduced = reduceQuery?.matches ?? false;

    let scene: CanvasScene | null = null;
    try {
      scene = createScene(ctx, {
        reducedMotion: reduced,
        coarsePointer: coarseQuery?.matches ?? false,
      });
    } catch {
      scene = null;
    }
    if (!scene) return undefined;
    const activeScene: CanvasScene = scene;

    const fixed = window.getComputedStyle(canvas).position === "fixed";
    const frameInterval = 1000 / Math.max(1, fps);

    // ------------------------------------------------------------ State
    let disposed = false;
    // Set when the scene throws: the canvas then stays as it is for good.
    let failed = false;
    let rafId = 0;
    let staticRafId = 0;
    let lastNow = 0;
    let elapsed = 0;
    let cssWidth = 0;
    let cssHeight = 0;
    let needsResize = true;
    let resized = false;
    let visible = false;
    let pageHidden = document.hidden;
    // Reduced motion owes a static frame: at first sight and after a resize.
    let staticDirty = true;

    // Layout cache. `rectTop` was measured when the page was scrolled to
    // `measuredScrollY`; scrolling since is applied arithmetically.
    let rectLeft = 0;
    let rectTop = 0;
    let measuredScrollX = 0;
    let measuredScrollY = 0;
    let scrollX = window.scrollX;
    let scrollY = window.scrollY;
    let viewportHeight = window.innerHeight;

    let clientX = 0;
    let clientY = 0;
    let pointerActive = false;

    const frame: CanvasFrame = {
      ctx,
      width: 0,
      height: 0,
      dpr: 1,
      time: 0,
      delta: 0,
      pointer: { x: 0, y: 0, px: 0, py: 0, active: false, inside: false },
      scroll: { y: scrollY, viewportHeight, top: 0, progress: 0.5 },
      reducedMotion: reduced,
      first: true,
    };
    const size: CanvasSize = { width: 0, height: 0, dpr: 1 };

    // ------------------------------------------------------------ Layout
    // The size itself comes only from the ResizeObserver: it reports the
    // layout box, which a transformed ancestor (a reveal, a tilt) does not
    // distort the way it distorts getBoundingClientRect.
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      rectLeft = rect.left;
      rectTop = rect.top;
      measuredScrollX = window.scrollX;
      measuredScrollY = window.scrollY;
      scrollX = measuredScrollX;
      scrollY = measuredScrollY;
    };

    const targetDpr = () => {
      let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      if (maxPixels > 0 && cssWidth * cssHeight > 0) {
        dpr = Math.min(dpr, Math.sqrt(maxPixels / (cssWidth * cssHeight)));
      }
      return Math.max(0.5, dpr);
    };

    const applyResize = () => {
      if (cssWidth <= 0 || cssHeight <= 0) return;
      needsResize = false;
      const dpr = targetDpr();
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      size.width = cssWidth;
      size.height = cssHeight;
      size.dpr = pixelWidth / cssWidth;
      frame.width = size.width;
      frame.height = size.height;
      frame.dpr = size.dpr;
      activeScene.resize(size);
      resized = true;
    };

    // ------------------------------------------------------------ Frame
    const fillFrame = () => {
      const pointer = frame.pointer;
      let left = rectLeft;
      let top = rectTop;
      if (!fixed) {
        left -= scrollX - measuredScrollX;
        top -= scrollY - measuredScrollY;
      }
      const w = frame.width || 1;
      const h = frame.height || 1;
      pointer.px = clientX - left;
      pointer.py = clientY - top;
      pointer.x = (pointer.px / w) * 2 - 1;
      pointer.y = (pointer.py / h) * 2 - 1;
      pointer.active = pointerActive && !reduced;
      pointer.inside =
        pointer.active &&
        pointer.px >= 0 &&
        pointer.py >= 0 &&
        pointer.px <= w &&
        pointer.py <= h;

      const scroll = frame.scroll;
      scroll.y = scrollY;
      scroll.viewportHeight = viewportHeight;
      scroll.top = top;
      scroll.progress = fixed
        ? 0.5
        : Math.min(1, Math.max(0, (viewportHeight - top) / (viewportHeight + h)));
      frame.reducedMotion = reduced;
    };

    const draw = (delta: number) => {
      try {
        if (needsResize) applyResize();
        if (frame.width <= 0 || frame.height <= 0) return;
        fillFrame();
        frame.delta = delta;
        frame.time = reduced ? staticTime : elapsed;
        if (resized) {
          frame.first = true;
          resized = false;
        }
        activeScene.render(frame);
      } catch {
        // A drawing failure must never take the page down: stop for good.
        failed = true;
        stop();
        return;
      }
      frame.first = false;
    };

    const tick = (now: number) => {
      rafId = 0;
      if (disposed || !shouldRun()) return;
      rafId = window.requestAnimationFrame(tick);

      let delta = 0;
      if (lastNow !== 0) {
        const since = now - lastNow;
        // A millisecond of slack keeps a 60 fps cap from dropping frames to
        // timer jitter on a 60 Hz display.
        if (since < frameInterval - 1) return;
        delta = Math.min(since / 1000, MAX_DELTA);
      }
      lastNow = now;
      elapsed += delta;
      draw(delta);
    };

    const shouldRun = () => !reduced && !failed && visible && !pageHidden;

    const start = () => {
      if (disposed || rafId !== 0 || !shouldRun()) return;
      lastNow = 0;
      frame.first = true;
      rafId = window.requestAnimationFrame(tick);
    };

    function stop() {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      rafId = 0;
    }

    // Reduced motion: one frame when the canvas first nears the viewport and
    // one after each resize, batched to the next animation frame.
    const requestStatic = () => {
      if (disposed || failed || !reduced || !visible || !staticDirty) return;
      if (staticRafId !== 0) return;
      staticRafId = window.requestAnimationFrame(() => {
        staticRafId = 0;
        if (disposed || !reduced) return;
        frame.first = true;
        draw(0);
        if (frame.width > 0 && frame.height > 0 && !needsResize) staticDirty = false;
      });
    };

    const refresh = () => {
      if (reduced) requestStatic();
      else start();
    };

    // ------------------------------------------------------------ Observers
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      if (width !== cssWidth || height !== cssHeight) {
        cssWidth = width;
        cssHeight = height;
        needsResize = true;
        staticDirty = true;
      }
      // Layout is clean inside a ResizeObserver callback, so this is cheap.
      measure();
      refresh();
    });
    resizeObserver.observe(canvas);

    // Content above the canvas can grow without the canvas resizing; the
    // document's size changes with it, so re-measure then.
    const documentObserver = new ResizeObserver(() => {
      if (!fixed) measure();
    });
    documentObserver.observe(document.documentElement);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting;
        if (visible) refresh();
        else stop();
      },
      { rootMargin }
    );
    intersectionObserver.observe(canvas);

    // ------------------------------------------------------------ Listeners
    const onScroll = () => {
      scrollX = window.scrollX;
      scrollY = window.scrollY;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      clientX = event.clientX;
      clientY = event.clientY;
      pointerActive = true;
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) pointerActive = false;
    };

    const onBlur = () => {
      pointerActive = false;
    };

    const onVisibility = () => {
      pageHidden = document.hidden;
      if (pageHidden) stop();
      else refresh();
    };

    const onWindowResize = () => {
      viewportHeight = window.innerHeight;
      if (Math.abs(targetDpr() - size.dpr) > 0.01) {
        needsResize = true;
        staticDirty = true;
      }
      refresh();
    };

    const onReduceChange = () => {
      reduced = reduceQuery?.matches ?? false;
      frame.reducedMotion = reduced;
      if (reduced) {
        stop();
        staticDirty = true;
        requestStatic();
      } else {
        start();
      }
    };

    // The device pixel ratio can change without a resize event (moving the
    // window to another monitor); a resolution query catches that.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      needsResize = true;
      staticDirty = true;
      watchDpr();
      refresh();
    };
    function watchDpr() {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = media(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery?.addEventListener("change", onDprChange);
    }
    watchDpr();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onWindowResize, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    reduceQuery?.addEventListener("change", onReduceChange);

    measure();
    refresh();

    return () => {
      disposed = true;
      stop();
      if (staticRafId !== 0) window.cancelAnimationFrame(staticRafId);
      staticRafId = 0;
      resizeObserver.disconnect();
      documentObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceQuery?.removeEventListener("change", onReduceChange);
      dprQuery?.removeEventListener("change", onDprChange);
      try {
        activeScene.dispose?.();
      } catch {
        // Disposal is best effort.
      }
    };
  }, [canvasRef, createScene, maxDpr, maxPixels, fps, rootMargin, staticTime]);
}
