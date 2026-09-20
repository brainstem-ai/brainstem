export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: [string, ...string[]];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface AskResult {
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  answers: Record<string, Answer>;
}

export interface SystemOne {
  readonly name: string;
  ask(state: unknown, questions: Record<string, Question>): Promise<AskResult>;
}

export interface AskCall {
  state: unknown;
  questions: Record<string, Question>;
}
