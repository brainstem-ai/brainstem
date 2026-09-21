export const CORE_VERSION = "0.1.0";

export * from "./types";
export {
  choice,
  noul,
  score,
} from "./types";
export { jevSystemOne, DEFAULT_JEV_MODEL } from "./providers/jev";
export { mockSystemOne, noulAnswer, choiceAnswer, scoreAnswer } from "./providers/mock";
export type { MockSystemOne } from "./providers/mock";
export { openJournal, appendJournalEvent, loadJournal, JOURNAL_SCHEMA_VERSION } from "./journal";
export type { Journal, JournalEvent, TurnSpans, ReflexStatus, ApprovalStatus } from "./journal";
export { hashAction, canonicalJson, newId } from "./evidence";
export type { TaskState, ToolObservation, ToolStatus } from "./evidence";
export { gateQuestions, sanitizeQuestions, pulseQuestions, steerQuestions, verifyQuestions, GATE_DISPOSITION_CRITERIA, SANITIZE_SEVERITY_LEVELS, CONTINUING_LEVELS } from "./questions";
export { policyForTrust, DEFAULT_TRUST } from "./policy";
export type { Policy } from "./policy";
export { staticVerdict } from "./floor";
export { ReflexEngine, decideGate, decideSanitize, decideVerify, decidePulse, decideSteer } from "./engine";
export type {
  GateDecision,
  GateInput,
  GateAction,
  SanitizeDecision,
  SanitizeAction,
  VerifyDecision,
  VerifyAction,
  PulseDecision,
  PulseAction,
  SteerDecision,
  ReflexEngineDeps,
  ReflexIds,
} from "./engine";
