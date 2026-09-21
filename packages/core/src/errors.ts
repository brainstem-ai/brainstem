export class JevUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JevUnavailableError";
  }
}

export class JevCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JevCancelledError";
  }
}

export function isCancelLike(error: unknown): boolean {
  return error instanceof JevCancelledError || (error instanceof Error && error.name === "AbortError");
}
