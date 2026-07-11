/**
 * Thrown when a single change cannot be applied but the batch should continue.
 * The orchestrator converts these into ApplyResult.skipped entries (never 500s).
 */
export class SkipChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipChangeError";
  }
}
