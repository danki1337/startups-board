// Where a tooltip bubble goes, as arithmetic rather than as a side effect inside a layout effect.
//
// Its own module, and plain JS, so a test can import and run it. That is the whole point: a tooltip
// is close to the worst possible automation target -- 18px tall, gated behind a 120ms delay,
// dismissed by any scroll, and attached by a real pointer transition that synthesised events do not
// reproduce. Three attempts to catch one in a browser harness measured the wrong element twice and
// nothing the third time. The placement is four lines of clamping; it should be checked as such.

/**
 * @param {{ left: number, top: number, width: number, bottom: number }} anchor
 *   the element being explained, in viewport coordinates (a DOMRect satisfies this)
 * @param {number} width   measured bubble width
 * @param {number} height  measured bubble height
 * @param {number} viewportWidth
 * @returns {{ left: number, top: number }}
 */
export function placeTip(anchor, width, height, viewportWidth) {
  // Centred on the anchor, not left-aligned to it. The bubble is usually much wider than the cropped
  // text it explains, so aligning their left edges hung it off to one side and it read as belonging
  // to whatever sat to the right rather than to the thing under the pointer.
  const centred = anchor.left + anchor.width / 2 - width / 2;
  // The clamp keeps a wide bubble on a near-edge cell from being centred half off-screen. Math.max
  // on the upper bound matters when the bubble is wider than the viewport: without it that bound
  // falls below 8 and Math.min pins the bubble PAST the left edge instead of at it.
  const left = Math.min(Math.max(8, centred), Math.max(8, viewportWidth - width - 8));
  // Above by preference -- the pointer is on the anchor, and a bubble under it covers the next row.
  const above = anchor.top - height - 8;
  return { left, top: above >= 8 ? above : anchor.bottom + 8 };
}
