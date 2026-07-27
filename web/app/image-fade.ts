"use client";

import { useCallback, useState } from "react";

// Every image on the page reveals through this hook. One module rather than four copies of three
// lines, because of the trap in the middle of it -- which has been got wrong twice here:
//
// An image already in the browser cache finishes decoding BEFORE React attaches onLoad. A reveal
// driven by onLoad alone therefore leaves every warm image at opacity 0 forever, waiting for an
// event that has already fired. `complete && naturalWidth > 0` on mount is the other half; either
// half alone is a bug, and which half you notice depends entirely on whether your cache was warm
// when you looked.
//
// `naturalWidth > 0` and not `complete` alone: a broken image is also "complete".
export function useImagePainted() {
  const [painted, setPainted] = useState(false);
  // Setting it to true when it is already true is a no-op in React, so this is safe to call from an
  // inline ref callback -- which runs on every render, since an inline arrow is a new identity each
  // time and React detaches and re-attaches it.
  const paint = useCallback((node: HTMLImageElement | null | undefined) => {
    if (node?.complete && node.naturalWidth > 0) setPainted(true);
  }, []);
  // The class pair, so no caller has to remember which half goes where. See .img-fade in globals:
  // an animation, deliberately, not a transition.
  return { painted, paint, fade: painted ? "img-fade" : "opacity-0" };
}
