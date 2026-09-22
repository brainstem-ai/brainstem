export type ApprovalResolution = "approve_once" | "deny";

export interface ApprovalRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  cwd: string;
  tool: string;
  validatedArgs: unknown;
  actionHash: string;
  reasons: string[];
  /** Canonical resolved filesystem target, when the action has one (e.g. a write's path after symlink/root resolution). Distinct from the raw path in validatedArgs. */
  target?: string;
  /**
   * The actual proposed diff or new-file content summary — the full,
   * unindiscriminately-bounded inspection channel for a human approver.
   * This is passed to the approval handler only; it is never durably
   * journaled alongside the (bounded) approval event.
   */
  changeSummary?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResolution>;
