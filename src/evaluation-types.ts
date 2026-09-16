// Browser-safe contracts: do not import the host evaluator from shared DSL types.
export type Content = string | { [key: string]: unknown } | unknown[]
export type Question = { instructions: Content } & (
  | { type: "noul"; criteria?: { true?: string; false?: string } }
  | { type: "choice"; criteria: Record<string, string | null> }
  | { type: "score"; criteria: string[] }
)
export interface EvaluationRequest { state: Content; questions: Record<string, Question>; model?: string }
export interface EvaluationOptions { label?: string; key?: string }
export type Answer = { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export interface EvaluationResult { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
/** Positional numeric answers only: identifiers and rubrics are source, not telemetry. */
export type EvaluationReceipt = { status: "failed"; code: string } | {
  status: "completed"
  model: string
  answers: Array<number | { value: number; probabilities: number[]; confidence: number }>
  usage: EvaluationResult["usage"]
}
