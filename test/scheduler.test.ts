import { expect, test } from "vitest";
import type { Attempt } from "../src/domain.js";
import { scheduler, trackForAttempt } from "../src/scheduler.js";

const attempt: Attempt = {
  id: "attempt-1",
  operationId: "operation-1",
  kind: "answered",
  question: {
    id: "question-1",
    kind: "primary",
    targetConceptId: "concept-1",
    prompt: "What is FSRS?",
    sourceRefs: [],
  },
  mode: "study",
  submittedAt: "2026-08-27T09:00:00.000Z",
  answer: "A scheduling algorithm",
  confidence: 3,
  unaidedAtSubmission: true,
  highestHintLevel: 0,
  revealed: false,
  correctness: "correct",
};

test("uses the injected review time and disables fuzz", () => {
  const now = new Date("2026-08-27T09:00:00.000Z");
  const updated = scheduler.apply(undefined, "correct", now)!;

  expect(updated.card.last_review).toEqual(now);
  expect(updated.reviewHistory).toHaveLength(1);
  expect(updated.reviewHistory[0]?.rating).toBe("Good");
});

test("never schedules ungradable evidence", () => {
  expect(scheduler.apply(undefined, "ungradable", new Date())).toBeUndefined();
  expect(
    trackForAttempt({ ...attempt, correctness: "ungradable" }),
  ).toBeUndefined();
});

test("routes hinted work only to assisted", () => {
  expect(trackForAttempt({ ...attempt, highestHintLevel: 1 })).toBe("assisted");
  expect(
    trackForAttempt({ ...attempt, highestHintLevel: 0, revealed: false }),
  ).toBe("unassisted");
  expect(trackForAttempt({ ...attempt, revealed: true })).toBe("assisted");
});

test("routes an unanswered exam item to the unaided review track", () => {
  const unansweredAttempt: Attempt = {
    id: "attempt-blank",
    operationId: "operation-blank",
    kind: "unanswered",
    question: { ...attempt.question, kind: "exam" },
    mode: "exam",
    submittedAt: "2026-08-27T09:00:00.000Z",
    unaidedAtSubmission: true,
    highestHintLevel: 0,
    revealed: false,
    omissionReason: "manual-partial",
  };

  expect(trackForAttempt(unansweredAttempt)).toBe("unassisted");
  expect(
    scheduler.applyAttempt(
      undefined,
      unansweredAttempt,
      new Date("2026-08-27T09:00:00.000Z"),
    )?.reviewHistory[0],
  ).toMatchObject({ rating: "Again" });
});

test("keeps card values JSON-compatible and returns its due date", () => {
  const now = new Date("2026-08-27T09:00:00.000Z");
  const updated = scheduler.apply(undefined, "partial", now)!;

  expect(() => JSON.stringify(updated)).not.toThrow();
  expect(updated.reviewHistory[0]?.rating).toBe("Hard");
  expect(scheduler.dueAt(updated)).toEqual(
    new Date(updated.card.due as string),
  );
});

test("maps incorrect answers to Again", () => {
  const updated = scheduler.apply(
    undefined,
    "incorrect",
    new Date("2026-08-27T09:00:00.000Z"),
  )!;

  expect(updated.reviewHistory[0]?.rating).toBe("Again");
});
