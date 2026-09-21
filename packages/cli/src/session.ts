import { hashAction, newId, type Journal, type Policy, type TaskState, type ToolObservation } from "@brainstem/core";
import type { TurnSpans } from "@brainstem/core";

const OBSERVATION_MEMORY = 50;

export interface SessionRecorderOptions {
  policy: Policy;
  trust: number;
}

export class SessionRecorder {
  readonly sessionId: string;
  readonly cwd: string;

  private readonly journal: Journal;
  private readonly startedAt = Date.now();
  private readonly repeatedCounts = new Map<string, number>();
  private readonly observations: ToolObservation[] = [];
  private currentTaskState: TaskState | undefined;
  private activeTurnId: string | undefined;
  private turnStartedAt = 0;
  private turnModelCalls = 0;
  private modelCallCount = 0;
  private costKnown = 0;
  private costUnknownSeen = false;

  constructor(journal: Journal, cwd: string, options: SessionRecorderOptions) {
    this.journal = journal;
    this.sessionId = newId("sess");
    this.cwd = cwd;
    this.journal.append({
      t: "session_start",
      v: 2,
      sessionId: this.sessionId,
      ts: Date.now(),
      trust: options.trust,
      policySnapshot: options.policy,
      policyHash: hashAction(options.policy),
    });
  }

  get currentTask(): TaskState | undefined {
    return this.currentTaskState;
  }

  get currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  get modelCalls(): number {
    return this.modelCallCount;
  }

  get totalCost(): number | "unknown" {
    return this.costUnknownSeen ? "unknown" : this.costKnown;
  }

  get repeatedActionCounts(): ReadonlyMap<string, number> {
    return this.repeatedCounts;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  // Task identity rule: every harness.prompt starts a new task — a prompt while
  // the agent is idle starts one, and so does a prompt while another run is in
  // flight (task per prompt). The one exception is input queued while an
  // approval is pending: once the approval resolves, the harness delivers the
  // queued text via agent.steer and records it with updateTask, which appends a
  // task_update and bumps the revision without ever overwriting the objective.
  startTask(objective: string): TaskState {
    const task: TaskState = { id: newId("task"), revision: 1, objective, updates: [] };
    this.currentTaskState = task;
    this.journal.append({
      t: "task_start",
      v: 2,
      sessionId: this.sessionId,
      taskId: task.id,
      ts: Date.now(),
      objective,
    });
    return task;
  }

  updateTask(text: string): TaskState {
    const task = this.currentTaskState;
    if (!task) throw new Error("updateTask called before startTask");
    task.revision += 1;
    task.updates.push(text);
    this.journal.append({
      t: "task_update",
      v: 2,
      taskId: task.id,
      revision: task.revision,
      ts: Date.now(),
      text,
    });
    return task;
  }

  beginTurn(): string {
    const task = this.currentTaskState;
    if (!task) throw new Error("beginTurn called before startTask");
    this.activeTurnId = newId("turn");
    this.turnStartedAt = Date.now();
    this.turnModelCalls = 0;
    this.journal.append({
      t: "turn_start",
      v: 2,
      sessionId: this.sessionId,
      taskId: task.id,
      turnId: this.activeTurnId,
      ts: this.turnStartedAt,
    });
    return this.activeTurnId;
  }

  endTurn(extraSpans?: TurnSpans): void {
    if (!this.activeTurnId) throw new Error("endTurn called before beginTurn");
    this.journal.append({
      t: "turn_end",
      v: 2,
      turnId: this.activeTurnId,
      ts: Date.now(),
      modelCalls: this.turnModelCalls,
      durationMs: Date.now() - this.turnStartedAt,
      ...(extraSpans !== undefined ? { spans: extraSpans } : {}),
    });
    this.activeTurnId = undefined;
  }

  recordModelCall(): void {
    this.modelCallCount += 1;
    this.turnModelCalls += 1;
  }

  recordCost(cost: number | "unknown"): void {
    if (cost === "unknown") this.costUnknownSeen = true;
    else this.costKnown += cost;
  }

  recordAction(actionHash: string): void {
    this.repeatedCounts.set(actionHash, (this.repeatedCounts.get(actionHash) ?? 0) + 1);
  }

  recordObservation(observation: ToolObservation): void {
    this.observations.push(observation);
    if (this.observations.length > OBSERVATION_MEMORY) {
      this.observations.splice(0, this.observations.length - OBSERVATION_MEMORY);
    }
  }

  recentActivity(n: number): string[] {
    return this.observations.slice(-n).map((obs) => observationLine(obs));
  }

  endSession(reason: "normal" | "error", error?: string): void {
    this.journal.append({
      t: "session_end",
      v: 2,
      sessionId: this.sessionId,
      ts: Date.now(),
      reason,
      ...(error !== undefined ? { error } : {}),
    });
  }
}

function observationLine(obs: ToolObservation): string {
  const args = (obs.argsSummary ?? {}) as { command?: string; path?: string; pattern?: string };
  const subject = args.command ?? args.path ?? args.pattern ?? JSON.stringify(obs.argsSummary ?? {}).slice(0, 80);
  if (obs.status === "blocked") return `${obs.tool}: ${subject} (blocked)`;
  const timing = `(${obs.exitCode !== undefined ? `exit ${obs.exitCode}` : obs.status}, ${(obs.durationMs / 1000).toFixed(1)}s)`;
  return `${obs.tool}: ${subject} ${timing}`;
}
