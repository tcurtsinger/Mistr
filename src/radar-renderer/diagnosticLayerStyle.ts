/**
 * Engineering alignment geometry stays installed for packaged evidence, but it
 * must never cover weather pixels in the normal product map.
 */
export const HIDDEN_DIAGNOSTIC_LAYOUT = Object.freeze({
  visibility: "none" as const,
});
