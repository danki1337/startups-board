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
  // Whether the element has been attached at least once. An inline ref callback is a new identity on
  // every render, so React detaches and re-attaches it constantly; only the FIRST attachment can
  // tell us whether the image was already in cache.
  const seen = useRef(false);

  const paint = useCallback((node: HTMLImageElement | null | undefined) => {
    if (!node) return;
    const ready = node.complete && node.naturalWidth > 0;
    if (!seen.current) {
      seen.current = true;
      // Already decoded the first time we saw it: it is on screen with the HTML, so it is painted
      // but must NOT be animated. Fading it here would hide something the reader can already see.
      setReveal(ready ? "instant" : "waiting");
      return;
    }
    if (ready) setReveal((current) => (current === "waiting" ? "arrived" : current));
  }, []);

  return {
    // Has pixels, however they got here. Callers that stack a logo over a monogram need this to know
    // when to swap, and a cached logo has to count -- otherwise a warm page shows only monograms.
    painted: reveal === "instant" || reveal === "arrived",
    paint,
    // Hides an image we know is not ready. Empty while unknown, which is what keeps a cached image
    // visible from the very first paint instead of blinking through a fade on every refresh.
    hidden: reveal === "waiting" ? "opacity-0" : "",
    // The fade itself, and ONLY for an image that actually had to be waited for.
    fade: reveal === "arrived" ? "img-fade" : "",
  };
}
