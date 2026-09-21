export interface BudgetState {
  modelCalls: number;
  elapsedMs: number;
  knownSpendUsd: number | "unknown";
}

export interface BudgetLimits {
  maxModelCalls?: number;
  maxElapsedMs?: number;
  maxSpendUsd?: number;
}

export type BudgetCheck = { ok: true } | { ok: false; breached: string[] };

// Limits are evaluated on state accumulated so far, before a new call: reaching a cap is a breach
// (the next call would exceed it). Unknown spend cannot breach a spend budget — only a known dollar figure can exceed maxSpendUsd.
export function checkBudgets(state: BudgetState, limits: BudgetLimits): BudgetCheck {
  const breached: string[] = [];
  if (limits.maxModelCalls !== undefined && state.modelCalls >= limits.maxModelCalls) {
    breached.push("maxModelCalls");
  }
  if (limits.maxElapsedMs !== undefined && state.elapsedMs >= limits.maxElapsedMs) {
    breached.push("maxElapsedMs");
  }
  if (limits.maxSpendUsd !== undefined && state.knownSpendUsd !== "unknown" && state.knownSpendUsd >= limits.maxSpendUsd) {
    breached.push("maxSpendUsd");
  }
  return breached.length === 0 ? { ok: true } : { ok: false, breached };
}
