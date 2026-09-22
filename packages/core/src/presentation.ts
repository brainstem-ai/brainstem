// The single character-based bound applied to any text before it is handed to
// Sanitize/Verify and, unless a tool's own output is already smaller, to what
// is actually delivered to the model. Keeping exactly one named constant (and
// one function that applies it) is what makes "the judge saw what was
// delivered" a true statement instead of two independently-maintained slices
// that can drift apart.
export const REVIEW_CHAR_CAP = 8_000;

export interface BoundedText {
  text: string;
  truncated: boolean;
  shownChars: number;
  totalChars: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Bounds `text` to at most `capChars` UTF-16 code units without splitting a
 * surrogate pair. This is a character count, not a byte count — callers that
 * need byte accounting (artifact capture) use a separate measure.
 */
export function boundForReview(text: string, capChars: number = REVIEW_CHAR_CAP): BoundedText {
  const totalChars = text.length;
  if (totalChars <= capChars) {
    return { text, truncated: false, shownChars: totalChars, totalChars };
  }
  let end = capChars;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  const shown = text.slice(0, end);
  return { text: shown, truncated: true, shownChars: shown.length, totalChars };
}
