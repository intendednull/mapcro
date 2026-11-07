/**
 * Capture a pointer for a gesture, if the browser lets us. Capture keeps moves coming when the
 * pointer leaves the element; without it the gesture still works inside the element. A throw
 * here (the pointer already released, say) must never abort the gesture.
 */
export function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // ignored: see above
  }
}
