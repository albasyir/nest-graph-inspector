/**
 * web-llm's load progress, in the shape a progress bar can use.
 *
 * `InitProgressReport.progress` is a fraction, `text` is a human sentence
 * web-llm writes itself ("Fetching param cache[6/38]: 512MB fetched..."). Both
 * come from the library rather than from us, so both are treated as untrusted:
 * a report that arrives mid-reload with no fields at all must not paint a bar
 * at `NaN%` or leave the panel with a blank status line.
 */

export type WebLlmProgress = {
  /** Integral, clamped to 0..100. */
  percent: number
  label: string
  /**
   * The stage the label belongs to, with its counters removed — so
   * "Fetching param cache[6/38]: 512MB fetched…" and "Fetching param
   * cache[7/38]: 530MB fetched…" are recognisably the same step.
   */
  stage: string
}

const FALLBACK_LABEL = 'Preparing model'

/**
 * Everything web-llm writes before it starts counting.
 *
 * Its progress sentences are built as `<stage>[<i>/<n>]: <numbers>`, so the
 * text up to the first bracket or colon is the stage and the rest is a running
 * total that changes on every single report.
 */
const STAGE_NAME = /^[^[:]+/

export function formatWebLlmProgress(
  report: { progress?: number, text?: string, timeElapsed?: number }
): WebLlmProgress {
  const progress = report.progress
  const fraction = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0
  // web-llm reports the very first stage with an empty string, which would
  // otherwise show as a gap where the status line should be.
  const label = report.text?.trim() || FALLBACK_LABEL

  return {
    percent: Math.min(100, Math.max(0, Math.round(fraction * 100))),
    label,
    stage: STAGE_NAME.exec(label)?.[0].trim() || label
  }
}
