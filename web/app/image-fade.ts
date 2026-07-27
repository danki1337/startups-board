"use client";

import { useCallback, useRef, useState } from "react";

// Every image on the page reveals through this hook. One module rather than five copies of it,
// because of two traps that are easy to get wrong in opposite directions.
//
// TRAP ONE, the cached image. An image already in the browser cache finishes decoding BEFORE React
// attaches onLoad, so a reveal driven by onLoad alone leaves every warm image at opacity 0 forever,
// waiting for an event that has already fired. `complete && naturalWidth > 0` on mount is the other
// half; either half alone is a bug, and which one you notice depends entirely on whether your cache
// was warm when you looked. (`naturalWidth > 0` and not `complete` alone: a broken image is also
// "complete".)
//
// TRAP TWO, and the reason this file was rewritten: the server must NOT guess. It used to render
// every image at opacity 0 and let the client fade it in, which meant that on a REFRESH -- when
// every image is already in cache and could paint with the HTML -- the whole page hid its own images
// and faded them back in. That is not a reveal, it is a blink, and it happened on every single load.
//
// So the initial state is "unknown", which renders no opacity class at all. An image with no pixels
// yet paints nothing regardless of its opacity, so being visible costs nothing while it loads; and
// an image that IS cached now appears with the HTML, which is the whole point. Only once the element
// is attached on the client and turns out not to be ready do we hide it -- invisible either way, so
// nothing flickers -- and only then does its arrival get a fade.
//
// The server render and the first client render both produce "", so hydration matches.
// Whether the page's own first load is over.
//
// This is the part the previous attempt got wrong. It only skipped the fade when the image was
// ALREADY decoded at the moment React attached the ref -- but on a reload the browser is still
// reading those images out of its own disk cache, so `complete` is false, and every one of them got
// hidden and faded back in anyway. The blink survived the fix.
//
// A reveal is only ever worth playing for an image that turns up LATER than the page around it: a
// row scrolled into view, a dropdown opened. Nothing in the first screenful qualifies, cached or
// not, because the reader is watching the whole page arrive at once and does not need each part of
// it announced. So the fade is switched off entirely until the load event, and everything mounting
// before that simply appears -- which for a cached image means appearing instantly, with the HTML.
let firstLoadOver = false;
if (typeof window !== "undefined") {
  if (document.readyState === "complete") firstLoadOver = true;
  else window.addEventListener("load", () => { firstLoadOver = true; }, { once: true });
}

// unknown -> not attached yet (server, and the first client render)
// waiting -> attached, no pixels; hidden, and its arrival will be faded
// instant -> attached and ALREADY decoded; visible with no animation at all
// arrived -> the pixels turned up while we were waiting; faded in
//
// "instant" renders exactly the same classes as "unknown" -- neither hides nor animates -- which is
// what lets the state settle during hydration without anything moving on screen.
type Reveal = "unknown" | "waiting" | "instant" | "arrived";

export function useImagePainted() {
  const [reveal, setReveal] = useState<Reveal>("unknown");
  // Captured on the FIRST render and never updated: whether this particular image belongs to the
  // page's own load. An image that mounts during hydration keeps "instant" behaviour for its whole
  // life even if it loads a second later, because it is part of the arrival the reader already saw.
  const reveals = useRef(firstLoadOver);
  // Whether the element has been attached at least once. An inline ref callback is a new identity on
  // every render, so React detaches and re-attaches it constantly; only the FIRST attachment can
  // tell us whether the image was already in cache.
  const seen = useRef(false);

  const paint = useCallback((node: HTMLImageElement | null | undefined) => {
    if (!node) return;
    const ready = node.complete && node.naturalWidth > 0;
    if (!seen.current) {
      seen.current = true;
      // Part of the page's own arrival: never hidden, never faded, whether or not it has decoded
      // yet. An image with no pixels paints nothing anyway, so leaving it visible costs nothing and
      // is what stops a reload hiding its own cached images.
      if (!reveals.current) { setReveal("instant"); return; }
      setReveal(ready ? "instant" : "waiting");
      return;
    }
    if (ready) setReveal((current) => (current === "waiting" ? "arrived" : current));
  }, []);

  return {
    // Has pixels, or is on screen regardless. Callers that stack a logo over a monogram need this to
    // know when to swap, and a cached logo has to count -- otherwise a warm page shows only
    // monograms. During the page's own load this settles true immediately, which is the point.
    painted: reveal === "instant" || reveal === "arrived",
    paint,
    // Hides an image we know is not ready AND that arrived after the page did. Empty otherwise,
    // which is what keeps a reload from blinking through a fade it never needed.
    hidden: reveal === "waiting" ? "opacity-0" : "",
    // The fade itself, and ONLY for an image that turned up later than the page around it.
    fade: reveal === "arrived" ? "img-fade" : "",
  };
}
