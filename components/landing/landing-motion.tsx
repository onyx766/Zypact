"use client";

import { useEffect } from "react";

/**
 * The landing page's single motion driver.
 *
 * Sections stay server components and opt into motion with data attributes;
 * this one client island finds them after hydration and drives them with
 * plain DOM writes — no React state, so pointer and scroll work never
 * re-renders anything. The CSS half of each contract lives in
 * components/landing/styles/base.css.
 *
 *   data-reveal[="up|left|right|scale|blur|rotate|flip|mask"]
 *                       adds .is-in once the element scrolls into view
 *   data-draw           same, for SVG strokes drawn with pathLength="1"
 *   data-stagger="ms"   spaces the reveals inside a group
 *   data-count-to="n"   counts up to n when first seen; optional
 *                       data-count-from / data-count-decimals
 *   data-tilt[="deg"]   3D pointer tilt (fine pointers only), data-tilt-glare
 *   data-magnetic[="px"]  drifts toward the pointer
 *   data-spotlight      pointer-following light (--sx/--sy/--sa)
 *   data-scroll         writes --p, the element's progress through the viewport
 *   data-flip           taps toggle .is-flipped (coarse pointers)
 *   data-spy="id"       marks the nav link for the section in view (data-active)
 *   data-lx-header      gets data-scrolled once the page leaves the top
 *   data-lx-progress    receives --progress, the page scroll fraction
 *
 * With `prefers-reduced-motion: reduce` everything is shown in its final
 * state at once and only the non-motion behaviours (header state, scrollspy,
 * progress) run.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".lx");
    if (!root) return undefined;
    return startMotion(root);
  }, []);

  return null;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function startMotion(root: HTMLElement): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const disposers: Array<() => void> = [];
  const frames = new Set<number>();

  const raf = (callback: FrameRequestCallback) => {
    const id = requestAnimationFrame((time) => {
      frames.delete(id);
      callback(time);
    });
    frames.add(id);
    return id;
  };

  /* ------------------------------------------------------------ Stagger */
  root.querySelectorAll<HTMLElement>("[data-stagger]").forEach((group) => {
    const step = Number(group.dataset.stagger) || 80;
    const base = Number(group.dataset.staggerBase) || 0;
    let index = 0;
    group.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
      if (el.closest("[data-stagger]") !== group) return;
      if (!el.style.getPropertyValue("--lx-delay")) {
        el.style.setProperty("--lx-delay", `${base + index * step}ms`);
      }
      index += 1;
    });
  });

  /* ------------------------------------------------------ Reveal + draw */
  const revealEls = Array.from(
    root.querySelectorAll<HTMLElement>("[data-reveal], [data-draw]")
  );

  if (reduce) {
    revealEls.forEach((el) => el.classList.add("is-in"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -9% 0px", threshold: 0 }
    );
    revealEls.forEach((el) => revealObserver.observe(el));
    disposers.push(() => revealObserver.disconnect());
  }

  /* ----------------------------------------------------------- Counters */
  const counters = Array.from(
    root.querySelectorAll<HTMLElement>("[data-count-to]")
  );

  const writeCount = (el: HTMLElement, text: string) => {
    // Rewrite the existing text node rather than replacing it, so React's
    // reference to the hydrated node stays valid.
    const node = el.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = text;
    else el.textContent = text;
  };

  if (!reduce && counters.length > 0) {
    const finals = new Map<HTMLElement, string>();

    const run = (el: HTMLElement) => {
      const to = Number(el.dataset.countTo);
      const from = Number(el.dataset.countFrom ?? 0);
      const decimals = Number(el.dataset.countDecimals ?? 0);
      const duration = Number(el.dataset.countDuration) || 1500;
      const delay = Number(el.dataset.countDelay) || 0;
      const final = finals.get(el) ?? String(to);
      let start = 0;

      const tick = (now: number) => {
        if (!start) start = now + delay;
        const t = clamp((now - start) / duration, 0, 1);
        const eased = 1 - Math.pow(1 - t, 4);
        writeCount(
          el,
          t >= 1 ? final : (from + (to - from) * eased).toFixed(decimals)
        );
        if (t < 1) raf(tick);
      };
      raf(tick);
    };

    const countObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          countObserver.unobserve(entry.target);
          run(entry.target as HTMLElement);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0 }
    );

    counters.forEach((el) => {
      const to = Number(el.dataset.countTo);
      if (!Number.isFinite(to)) return;
      finals.set(el, el.textContent ?? String(to));

      // Only count what the visitor has not already seen. A counter that is
      // on screen and not inside a still-hidden reveal keeps its value.
      const rect = el.getBoundingClientRect();
      const onScreen = rect.top < window.innerHeight && rect.bottom > 0;
      const hidden = el.closest("[data-reveal]:not(.is-in)") !== null;
      if (onScreen && !hidden) return;

      const from = Number(el.dataset.countFrom ?? 0);
      writeCount(el, from.toFixed(Number(el.dataset.countDecimals ?? 0)));
      countObserver.observe(el);
    });

    disposers.push(() => {
      countObserver.disconnect();
      finals.forEach((text, el) => writeCount(el, text));
    });
  }

  /* -------------------------------------------- Pointer: tilt, magnet, light */
  if (fine && !reduce) {
    let tiltEl: HTMLElement | null = null;
    let tiltRect: DOMRect | null = null;
    let magnetEl: HTMLElement | null = null;
    let spotEl: HTMLElement | null = null;
    let pending: PointerEvent | null = null;
    let scheduled = false;

    const resetTilt = (el: HTMLElement) => {
      el.classList.remove("is-tilting");
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.style.setProperty("--ga", "0");
    };

    const resetMagnet = (el: HTMLElement) => {
      el.style.setProperty("--mx", "0px");
      el.style.setProperty("--my", "0px");
    };

    const resetSpot = (el: HTMLElement) => {
      el.style.setProperty("--sa", "0");
    };

    const apply = () => {
      scheduled = false;
      const event = pending;
      if (!event) return;
      const target = event.target instanceof Element ? event.target : null;

      // Tilt. The rect is captured when the pointer arrives, while the
      // element is still at rest, so the tilt it then applies cannot feed
      // back into the next measurement.
      const nextTilt = target?.closest<HTMLElement>("[data-tilt]") ?? null;
      if (nextTilt !== tiltEl) {
        if (tiltEl) resetTilt(tiltEl);
        tiltEl = nextTilt;
        tiltRect = tiltEl ? tiltEl.getBoundingClientRect() : null;
      }
      if (tiltEl && tiltRect) {
        const px = clamp((event.clientX - tiltRect.left) / tiltRect.width, 0, 1);
        const py = clamp((event.clientY - tiltRect.top) / tiltRect.height, 0, 1);
        const max = Number(tiltEl.dataset.tilt) || 8;
        tiltEl.classList.add("is-tilting");
        tiltEl.style.setProperty("--rx", `${((0.5 - py) * 2 * max).toFixed(2)}deg`);
        tiltEl.style.setProperty("--ry", `${((px - 0.5) * 2 * max).toFixed(2)}deg`);
        tiltEl.style.setProperty("--gx", `${(px * 100).toFixed(1)}%`);
        tiltEl.style.setProperty("--gy", `${(py * 100).toFixed(1)}%`);
        tiltEl.style.setProperty("--ga", "1");
      }

      // Magnetic buttons.
      const nextMagnet = target?.closest<HTMLElement>("[data-magnetic]") ?? null;
      if (nextMagnet !== magnetEl) {
        if (magnetEl) resetMagnet(magnetEl);
        magnetEl = nextMagnet;
      }
      if (magnetEl) {
        const rect = magnetEl.getBoundingClientRect();
        const reach = Number(magnetEl.dataset.magnetic) || 10;
        const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
        const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
        magnetEl.style.setProperty("--mx", `${(clamp(dx, -1, 1) * reach).toFixed(1)}px`);
        magnetEl.style.setProperty("--my", `${(clamp(dy, -1, 1) * reach * 0.6).toFixed(1)}px`);
      }

      // Spotlight.
      const nextSpot = target?.closest<HTMLElement>("[data-spotlight]") ?? null;
      if (nextSpot !== spotEl) {
        if (spotEl) resetSpot(spotEl);
        spotEl = nextSpot;
      }
      if (spotEl) {
        const rect = spotEl.getBoundingClientRect();
        spotEl.style.setProperty("--sx", `${(event.clientX - rect.left).toFixed(0)}px`);
        spotEl.style.setProperty("--sy", `${(event.clientY - rect.top).toFixed(0)}px`);
        spotEl.style.setProperty("--sa", "1");
      }
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      pending = event;
      if (!scheduled) {
        scheduled = true;
        raf(apply);
      }
    };

    const resetAll = () => {
      pending = null;
      if (tiltEl) resetTilt(tiltEl);
      if (magnetEl) resetMagnet(magnetEl);
      if (spotEl) resetSpot(spotEl);
      tiltEl = magnetEl = spotEl = null;
      tiltRect = null;
    };

    // Scrolling moves the element under a stationary pointer; re-measure.
    const onScrollInvalidate = () => {
      if (tiltEl) {
        resetTilt(tiltEl);
        tiltEl = null;
        tiltRect = null;
      }
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", resetAll);
    window.addEventListener("blur", resetAll);
    window.addEventListener("scroll", onScrollInvalidate, { passive: true });
    disposers.push(() => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", resetAll);
      window.removeEventListener("blur", resetAll);
      window.removeEventListener("scroll", onScrollInvalidate);
      resetAll();
    });
  }

  /* -------------------------------------------------------- Flip on tap */
  if (!fine) {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest<HTMLElement>("[data-flip]");
      if (!card || !root.contains(card)) return;
      if (target?.closest("a, button, summary, input, textarea, select")) return;
      card.classList.toggle("is-flipped");
    };
    root.addEventListener("click", onClick);
    disposers.push(() => root.removeEventListener("click", onClick));
  }

  /* ---------------------------------------- Scroll: header, progress, --p */
  const header = root.querySelector<HTMLElement>("[data-lx-header]");
  const progressEls = Array.from(
    root.querySelectorAll<HTMLElement>("[data-lx-progress]")
  );
  const scrollEls = Array.from(root.querySelectorAll<HTMLElement>("[data-scroll]"));
  const visibleScrollEls = new Set<HTMLElement>();

  let scrollObserver: IntersectionObserver | null = null;
  if (!reduce && scrollEls.length > 0) {
    scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) visibleScrollEls.add(el);
          else visibleScrollEls.delete(el);
        }
        scheduleScroll();
      },
      { rootMargin: "15% 0px 15% 0px", threshold: 0 }
    );
    scrollEls.forEach((el) => scrollObserver?.observe(el));
  } else {
    scrollEls.forEach((el) => el.style.setProperty("--p", "1"));
  }

  let scrollScheduled = false;
  const updateScroll = () => {
    scrollScheduled = false;
    const y = window.scrollY;
    const viewport = window.innerHeight;

    if (header) header.toggleAttribute("data-scrolled", y > 12);

    const max = document.documentElement.scrollHeight - viewport;
    const fraction = max > 0 ? clamp(y / max, 0, 1) : 0;
    progressEls.forEach((el) =>
      el.style.setProperty("--progress", fraction.toFixed(4))
    );

    visibleScrollEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const p = clamp((viewport - rect.top) / (viewport + rect.height), 0, 1);
      el.style.setProperty("--p", p.toFixed(4));
    });
  };

  function scheduleScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    raf(updateScroll);
  }

  window.addEventListener("scroll", scheduleScroll, { passive: true });
  window.addEventListener("resize", scheduleScroll);
  updateScroll();
  disposers.push(() => {
    window.removeEventListener("scroll", scheduleScroll);
    window.removeEventListener("resize", scheduleScroll);
    scrollObserver?.disconnect();
    header?.removeAttribute("data-scrolled");
  });

  /* ---------------------------------------------------------- Scrollspy */
  const spyLinks = Array.from(root.querySelectorAll<HTMLElement>("[data-spy]"));
  if (spyLinks.length > 0) {
    const sections = Array.from(
      new Set(spyLinks.map((link) => link.dataset.spy ?? ""))
    )
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
    const ids = sections.map((section) => section.id);
    const inBand = new Set<string>();

    const paint = () => {
      // Of the sections crossing the reading band, the one latest in the
      // document wins, so a short section nested in a long one still lights.
      const active = ids.filter((id) => inBand.has(id)).pop() ?? null;
      spyLinks.forEach((link) =>
        link.toggleAttribute("data-active", link.dataset.spy === active)
      );
    };

    const spyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) inBand.add(id);
          else inBand.delete(id);
        }
        paint();
      },
      { rootMargin: "-38% 0px -56% 0px", threshold: 0 }
    );
    sections.forEach((section) => spyObserver.observe(section));
    disposers.push(() => {
      spyObserver.disconnect();
      spyLinks.forEach((link) => link.removeAttribute("data-active"));
    });
  }

  /* -------------------------------------------------------------- Ready */
  root.setAttribute("data-motion", "ready");

  return () => {
    disposers.forEach((dispose) => dispose());
    frames.forEach((id) => cancelAnimationFrame(id));
    frames.clear();
    root.removeAttribute("data-motion");
  };
}
