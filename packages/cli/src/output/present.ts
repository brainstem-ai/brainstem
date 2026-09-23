import { boundForReview, getBit, isEmpty, REVIEW_CHAR_CAP, sliceByLines, type FocusDecision, type SectionManifest } from "@brainstem/core";

export type FocusRolloutMode = "off" | "shadow" | "on";

export const PRESENTED_LINE_CAP = 10;
// Decoupled from EXCERPT_CAP, which bounds the raw observation excerpt stored
// for recent-activity summaries — a different, pre-existing cap serving a
// different purpose.
export const FOCUS_PRESENT_BUDGET_CHARS = 4_000;

export interface PresentedView {
  text: string;
  truncated: boolean;
  presentedAs: "naive" | "focus_full" | "focus_select" | "focus_compute_or_retrieve";
}

const NAIVE_NOTICE = (artifactId: string, lineCap: number, totalLines: number) =>
  `[brainstem] capture archived as artifact ${artifactId}; showing lines 1-${lineCap} of ${totalLines} — use read_output or search_output to recover the omitted lines.`;

const NAIVE_CHAR_NOTICE = (artifactId: string, shownChars: number, totalChars: number) =>
  `[brainstem] capture archived as artifact ${artifactId}; showing the first ${shownChars} of ${totalChars} characters in this view — use read_output or search_output to recover the rest.`;

const COMPUTE_OR_RETRIEVE_NOTICE =
  "[brainstem] focus: no single section was clearly relevant to the task — use search_output with a specific pattern, or read_output for a range, to find what you need.";

// The line cap alone does not bound character count: a single very long line
// (or a handful of them) can still exceed the review boundary. Both bounds
// are enforced here, together, so nothing downstream can present more than
// REVIEW_CHAR_CAP characters of source text without Sanitize having reviewed
// exactly that same bounded text (see packages/core/src/presentation.ts).
export function presentNaive(fullText: string, artifactId: string, lineCap: number = PRESENTED_LINE_CAP): PresentedView {
  const slice = sliceByLines(fullText, 1, lineCap);
  const lineTruncated = slice.totalLines > lineCap;
  const candidate = lineTruncated ? slice.text : fullText;
  const bounded = boundForReview(candidate, REVIEW_CHAR_CAP);

  if (!lineTruncated && !bounded.truncated) {
    return { text: fullText, truncated: false, presentedAs: "naive" };
  }

  if (lineTruncated && !bounded.truncated) {
    return {
      text: `${slice.text}\n${NAIVE_NOTICE(artifactId, lineCap, slice.totalLines)}`,
      truncated: true,
      presentedAs: "naive",
    };
  }

  const notice = lineTruncated
    ? `${NAIVE_CHAR_NOTICE(artifactId, bounded.shownChars, candidate.length)} (also beyond the ${lineCap}-line window; ${slice.totalLines} lines total)`
    : NAIVE_CHAR_NOTICE(artifactId, bounded.shownChars, candidate.length);
  return { text: `${bounded.text}\n${notice}`, truncated: true, presentedAs: "naive" };
}

export function presentFocused(
  fullText: string,
  artifactId: string,
  manifest: SectionManifest,
  decision: FocusDecision,
  lineCap: number = PRESENTED_LINE_CAP,
): PresentedView {
  // `mode` alone governs what to show — `decision.selected` is only meaningful
  // when mode === "select" (see FocusDecision's own doc comment). Never wire
  // `selected` through for "full" or "compute_or_retrieve".
  if (decision.mode === "full") {
    const naive = presentNaive(fullText, artifactId, lineCap);
    return { ...naive, presentedAs: "focus_full" };
  }

  if (decision.mode === "compute_or_retrieve") {
    const naive = presentNaive(fullText, artifactId, lineCap);
    return {
      text: `${naive.text}\n${COMPUTE_OR_RETRIEVE_NOTICE}`,
      truncated: true,
      presentedAs: "focus_compute_or_retrieve",
    };
  }

  // mode === "select"
  if (isEmpty(decision.selected)) {
    // Should not happen given decideFocusMode's own logic, but never present
    // empty content as a successful selection.
    const naive = presentNaive(fullText, artifactId, lineCap);
    return { ...naive, presentedAs: "focus_full" };
  }

  const totalChars = manifest.entries.reduce((sum, s) => sum + s.text.length, 0);
  const selectedSections = manifest.entries.filter((_, i) => getBit(decision.selected, i));
  const selectedChars = selectedSections.reduce((sum, s) => sum + s.text.length, 0);
  const text = selectedSections.map((s) => s.text).join("\n\n");
  const omitted = selectedSections.length < manifest.entries.length;
  const bounded = boundForReview(text, REVIEW_CHAR_CAP);

  if (!omitted && !bounded.truncated) {
    return { text, truncated: false, presentedAs: "focus_select" };
  }

  const pieces: string[] = [];
  if (omitted) {
    pieces.push(
      `showing ${selectedSections.length} of ${manifest.entries.length} sections (${selectedChars} of ${totalChars} chars) relevant to the task`,
    );
  }
  if (bounded.truncated) {
    pieces.push(`the selected sections themselves were bounded to ${bounded.shownChars} of ${text.length} characters`);
  }
  const receipt = `[brainstem] focus: ${pieces.join("; ")}; archived as artifact ${artifactId} — use read_output or search_output to recover the rest.`;
  return { text: `${bounded.text}\n\n${receipt}`, truncated: true, presentedAs: "focus_select" };
}

export function presentArtifact(
  fullText: string,
  artifactId: string,
  opts: { rollout: FocusRolloutMode; manifest?: SectionManifest; decision?: FocusDecision },
): PresentedView {
  if (opts.rollout === "off" || opts.decision === undefined || opts.manifest === undefined) {
    return presentNaive(fullText, artifactId);
  }
  return presentFocused(fullText, artifactId, opts.manifest, opts.decision);
}
