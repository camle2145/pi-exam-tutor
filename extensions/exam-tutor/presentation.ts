import { Text } from "@earendil-works/pi-tui";
import type { SourceReference } from "../../src/domain.js";

export type ToolDisplayDetails = {
  display: string;
};

export function renderToolResult(
  result: {
    details?: ToolDisplayDetails;
    content: Array<{ type: string; text?: string }>;
  },
  _options: unknown,
  theme: { fg(color: string, text: string): string },
): Text {
  const display =
    result.details?.display ??
    result.content.find(({ type }) => type === "text")?.text ??
    "";
  return new Text(theme.fg("toolOutput", display), 0, 0);
}

export function toolResult(
  display: string,
  modelResult: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDisplayDetails;
} {
  return {
    content: [{ type: "text", text: modelResult }],
    details: { display },
  };
}

export function citations(sourceRefs: readonly SourceReference[]): string {
  return sourceRefs.map(citation).join("; ");
}

export function citation(sourceRef: SourceReference): string {
  return `${sourceRef.path} (${sourceRef.locator})`;
}

export function learnerSubmission(answer: string, confidence?: number): string {
  return [
    "<exam-tutor-learner-submission>",
    ...(confidence === undefined ? [] : [`confidence: ${confidence}`]),
    "answer:",
    answer,
    "</exam-tutor-learner-submission>",
  ].join("\n");
}

export function learnerExplanation(explanation: string): string {
  return [
    "<exam-tutor-learner-explanation>",
    explanation,
    "</exam-tutor-learner-explanation>",
  ].join("\n");
}
