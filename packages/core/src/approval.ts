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
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResolution>;
