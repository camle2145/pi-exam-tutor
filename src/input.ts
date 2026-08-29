import type { ExamDraft, ParseError, Submission } from "./domain.js";

const confidenceHeader = /^\[confidence: (.+)\]$/;
const examHeader = /^(.+)\. \[confidence: (.+)\]$/;

export function parseAnswer(text: string): Submission | ParseError {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex === -1) {
    return error("Answer must start with [confidence: N]");
  }

  const confidence = parseConfidence(lines[headerIndex]!.trim());
  if (typeof confidence !== "number") {
    return confidence;
  }

  const answer = lines
    .slice(headerIndex + 1)
    .join("\n")
    .trim();
  if (answer === "") {
    return error("Answer body must be nonempty");
  }

  return { answer, confidence };
}

export function parseExamDraft(
  text: string,
  itemIds: readonly string[],
): ExamDraft | ParseError {
  if (new Set(itemIds).size !== itemIds.length) {
    return error("Configured exam question IDs must be unique");
  }

  const configuredIds = new Set(itemIds);
  const drafts = Object.create(null) as Record<string, Submission>;
  const lines = text.split(/\r?\n/);
  let questionId: string | undefined;
  let confidence: number | undefined;
  let body: string[] = [];

  const commit = (): ParseError | undefined => {
    if (questionId === undefined || confidence === undefined) {
      return undefined;
    }
    const answer = body.join("\n").trim();
    if (answer === "") {
      return error(`Exam draft for ${questionId} must have a nonempty answer`);
    }
    drafts[questionId] = { answer, confidence };
    return undefined;
  };

  for (const line of lines) {
    const match = line.match(examHeader);
    if (match !== null) {
      const previousError = commit();
      if (previousError !== undefined) {
        return previousError;
      }

      const nextQuestionId = match[1]!;
      if (!configuredIds.has(nextQuestionId)) {
        return error(`Unknown exam question: ${nextQuestionId}`);
      }
      if (Object.hasOwn(drafts, nextQuestionId)) {
        return error(`Duplicate exam draft: ${nextQuestionId}`);
      }
      const parsedConfidence = parseConfidence(`[confidence: ${match[2]!}]`);
      if (typeof parsedConfidence !== "number") {
        return parsedConfidence;
      }

      questionId = nextQuestionId;
      confidence = parsedConfidence;
      body = [];
      continue;
    }

    if (questionId === undefined) {
      if (line.trim() !== "") {
        return error(
          "Exam drafts must start with a configured question header",
        );
      }
      continue;
    }
    body.push(line);
  }

  const finalError = commit();
  if (finalError !== undefined) {
    return finalError;
  }

  return { drafts };
}

function parseConfidence(header: string): number | ParseError {
  const match = header.match(confidenceHeader);
  if (match === null) {
    return error("First nonblank line must be [confidence: N]");
  }

  const value = match[1]!;
  if (!/^\d+$/.test(value)) {
    return error("Confidence must be an integer from 0–100");
  }

  const confidence = Number(value);
  if (confidence < 0 || confidence > 100) {
    return error("Confidence must be between 0–100");
  }
  return confidence;
}

function error(message: string): ParseError {
  return { message };
}
