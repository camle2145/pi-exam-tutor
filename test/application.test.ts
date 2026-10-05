import { expect, test } from "vitest";
import { buildDashboard } from "../src/dashboard.js";
import { createApplicationFixture, now } from "./application/setup.js";

test("excludes unanswered exam items from confidence calibration", async () => {
  const { course, question } = await createApplicationFixture();
  const answeredAttempt = {
    id: "attempt-answered",
    operationId: "operation-answered",
    kind: "answered" as const,
    question,
    mode: "study" as const,
    submittedAt: now.toISOString(),
    answer: "answer",
    confidence: 70,
    unaidedAtSubmission: true,
    highestHintLevel: 0 as const,
    revealed: false,
    correctness: "correct" as const,
  };
  const unansweredAttempt = {
    id: "attempt-unanswered",
    operationId: "operation-unanswered",
    kind: "unanswered" as const,
    question: { ...question, id: "exam-question", kind: "exam" as const },
    mode: "exam" as const,
    submittedAt: now.toISOString(),
    unaidedAtSubmission: true,
    highestHintLevel: 0 as const,
    revealed: false,
    omissionReason: "manual-partial" as const,
  };

  const dashboard = buildDashboard(
    course,
    {
      schemaVersion: 2,
      courseId: course.id,
      revision: 0,
      appliedOperationIds: [],
      concepts: {},
      attempts: [answeredAttempt, unansweredAttempt],
    },
    now,
  );

  expect(
    dashboard.confidenceCalibration.reduce(
      (count, bin) => count + bin.attempts,
      0,
    ),
  ).toBe(1);
  expect(dashboard.unansweredExamItems).toEqual([
    {
      questionId: unansweredAttempt.question.id,
      conceptId: unansweredAttempt.question.targetConceptId,
      omissionReason: "manual-partial",
    },
  ]);
});
