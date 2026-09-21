export const CORE_VERSION = "0.1.0";

export * from "./types";
export {
  choice,
  noul,
  score,
} from "./types";
export { JevUnavailableError, JevCancelledError } from "./errors";
export { jevSystemOne, withCircuitBreaker, DEFAULT_JEV_MODEL } from "./providers/jev";
export { mockSystemOne, noulAnswer, choiceAnswer, scoreAnswer } from "./providers/mock";
export type { MockSystemOne, MockSystemOneFactory } from "./providers/mock";
export { validateAnswers, validateGroups } from "./validation";
export { CircuitBreaker } from "./circuit-breaker";
export type { BreakerOptions } from "./circuit-breaker";
export { checkBudgets } from "./budgets";
export type { BudgetState, BudgetLimits, BudgetCheck } from "./budgets";
export { openJournal, appendJournalEvent, loadJournal, JOURNAL_SCHEMA_VERSION } from "./journal";
export type { Journal, JournalEvent, TurnSpans, ReflexStatus, ApprovalStatus } from "./journal";
export { hashAction, canonicalJson, newId } from "./evidence";
export { contentHash, countLines, searchContent, sliceByLines, InvalidPatternError } from "./artifacts";
export type { ArtifactMeta, ArtifactRecord, ArtifactEntry, ArtifactStore } from "./artifacts";
export type { ApprovalResolution, ApprovalRequest, ApprovalHandler } from "./approval";
export type { TaskState, ToolObservation, ToolStatus } from "./evidence";
export {
  createBitmap,
  cloneBitmap,
  setBit,
  clearBit,
  getBit,
  popcount,
  isEmpty,
  isFull,
  union,
  intersection,
  difference,
  equality,
  toIds,
  fromIds,
  encodeBitmap,
  decodeBitmap,
} from "./bitmap";
export type { CapabilityBitmap, EncodedBitmap } from "./bitmap";
export {
  compileCatalog,
  computeActive,
  workingSetFromIds,
  activeIds,
  cloneWorkingSet,
  CAPCAT_NAMESPACE,
  SECT_NAMESPACE,
} from "./capabilities";
export type {
  CapabilityDescriptor,
  CapabilityCatalog,
  WorkingSet,
  ComputeActiveOpts,
  ComputeActiveResult,
  SeedSource,
} from "./capabilities";
export { gateQuestions, sanitizeQuestions, pulseQuestions, steerQuestions, verifyQuestions, sanitizeVerifyGroups, GATE_DISPOSITION_CRITERIA, SANITIZE_SEVERITY_LEVELS, CONTINUING_LEVELS } from "./questions";
export { policyForTrust, DEFAULT_TRUST } from "./policy";
export type { Policy } from "./policy";
export { staticVerdict } from "./floor";
export { ReflexEngine, decideGate, decideSanitize, decideVerify, decidePulse, decideSteer, buildEnvelope } from "./engine";
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
  SteerInput,
  SteerOptions,
  SteerTier,
  ObservationEnvelope,
  ObserveToolResultInput,
  PulseFacts,
  RepeatedAction,
  PulseDecideFacts,
  ReflexEngineDeps,
  ReflexIds,
} from "./engine";
export {
  eligibleForSelection,
  buildSelectQuestions,
  decideSelect,
  batchCandidates,
  buildEvaluatedBitmap,
  buildFallbackDecision,
  encodeSelectId,
  decodeSelectId,
  SELECT_BATCH_CHAR_BUDGET,
} from "./selection";
export type {
  SelectableCapability,
  SelectInput,
  SelectReason,
  SelectDecision,
} from "./selection";
export {
  splitIntoSections,
  dependencyClosure,
} from "./output-sections";
export type {
  OutputSection,
  SectionManifest,
} from "./output-sections";
export {
  FOCUS_MIN_CHARS,
  FOCUS_BATCH_CHAR_BUDGET,
  isExhaustiveTask,
  encodeSectionId,
  decodeSectionId,
  buildFocusQuestions,
  batchSections,
  decideFocus,
  decideFocusMode,
  buildFallbackDecision as buildFocusFallbackDecision,
  buildExhaustiveDecision,
  assembleFocusDecision,
} from "./output-focus";
export type {
  FocusMode,
  FocusSectionReason,
  FocusInput,
  FocusDecision,
} from "./output-focus";
export { computeCacheKey, BoundedAnswerCache } from "./cache";
export type { AnswerCache, AnswerCacheEntry, BoundedAnswerCacheOptions } from "./cache";
