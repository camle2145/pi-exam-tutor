import { expect, test } from "vitest";
import { LearningService } from "../../src/application/learning-service.js";
import { buildDashboard } from "../../src/dashboard.js";
import { createApplicationFixture, now } from "./setup.js";

test("assisted correctness cannot create unassisted mastery evidence", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const activity = await app.requestMode(course.id, "study");
  const asked = await app.recordQuestion(activity, question);
  const hinted = await app.recordHint(await app.requestHint(asked), 1);
  const submitted = await app.acceptSubmission(hinted, {
    answer: "velocity increases",
    confidence: 90,
  });

  await app.recordGrade(submitted, {
    correctness: "correct",
    gradingRationale: "",
  });

  const progress = (await store.getHistory(course.id)).concepts.kinematics!;
  expect(progress.unassisted).toBeUndefined();
  expect(progress.assisted?.reviewHistory).toHaveLength(1);
});

test("persists answered primary submissions with confidence", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  await app.acceptSubmission(
    await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    ),
    { answer: "velocity increases", confidence: 70 },
  );

  expect((await store.getHistory(course.id)).attempts).toMatchObject([
    { kind: "answered", confidence: 70 },
  ]);
});

test("persists correction submissions without confidence or calibration readiness", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const submitted = await app.acceptSubmission(
    await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    ),
    { answer: "initial answer", confidence: 70 },
  );
  const correction = await app.recordGrade(submitted, {
    correctness: "incorrect",
    gradingRationale: "Incorrect.",
  });

  await app.acceptSubmission(correction, { answer: "corrected answer" });

  const attempts = (await store.getHistory(course.id)).attempts;
  expect(attempts.at(-1)).toMatchObject({
    kind: "answered",
    answer: "corrected answer",
  });
  expect(attempts.at(-1)).not.toHaveProperty("confidence");
});

test("records a branch retry instead of overwriting the original attempt", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const activity = await app.recordQuestion(
    await app.requestMode(course.id, "study"),
    question,
  );

  const original = await app.acceptSubmission(activity, {
    answer: "x",
    confidence: 50,
  });
  await app.recordGrade(original, {
    correctness: "correct",
    gradingRationale: "Correct.",
  });
  await app.acceptSubmission(activity, { answer: "x", confidence: 50 });

  const attempts = (await store.getHistory(course.id)).attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.retryOfAttemptId).toBe(attempts[0]?.id);
  expect(attempts[0]?.retryOfAttemptId).toBeUndefined();
});

test("persists incorrect unaided evidence before requiring correction", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const submitted = await app.acceptSubmission(
    await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    ),
    { answer: "x", confidence: 50 },
  );

  const next = await app.recordGrade(submitted, {
    correctness: "incorrect",
    gradingRationale: "The relationship is reversed.",
    misconception: "Acceleration does not decrease velocity here.",
  });

  expect(next.state).toMatchObject({ tag: "awaiting-correction" });
  const progress = (await store.getHistory(course.id)).concepts.kinematics!;
  expect(progress.unassisted?.reviewHistory[0]?.rating).toBe("Again");
  expect(progress.misconceptions).toHaveLength(1);
});

test("records a model-delivered reveal solution before requesting explanation", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const requested = await app.requestReveal(
    await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    ),
  );

  const next = await app.recordSolution(requested);

  expect(next.state).toMatchObject({
    tag: "awaiting-explanation",
    reason: "reveal",
  });
  const transfer = await app.recordExplanation(next, "I can now explain it.");
  expect(transfer.state.tag).toBe("awaiting-transfer");
  const [attempt] = (await store.getHistory(course.id)).attempts;
  expect(attempt).toMatchObject({
    revealed: true,
    highestHintLevel: 0,
    selfExplanation: "I can now explain it.",
  });
});

test("projects unaided evidence, calibration, due tracks, and unresolved misconceptions", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const complete = async (
    confidence: number,
    correctness: "correct" | "incorrect",
    hinted = false,
  ) => {
    let activity = await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    );
    if (hinted) {
      activity = await app.recordHint(await app.requestHint(activity), 1);
    }
    const submitted = await app.acceptSubmission(activity, {
      answer: "answer",
      confidence,
    });
    await app.recordGrade(submitted, {
      correctness,
      gradingRationale: "graded",
      ...(correctness === "incorrect"
        ? { misconception: "Acceleration changes velocity." }
        : {}),
    });
  };

  await complete(90, "correct");
  await complete(70, "correct");
  await complete(20, "correct");
  await complete(40, "incorrect", true);

  const dashboard = buildDashboard(
    course,
    await store.getHistory(course.id),
    new Date("2026-09-30T09:00:00.000Z"),
  );

  expect(dashboard.dueUnassisted).toEqual(["kinematics"]);
  expect(dashboard.dueAssisted).toEqual(["kinematics"]);
  expect(dashboard.unaidedCorrectRetrievalCount).toBe(3);
  expect(dashboard.unaidedEvidence).toBe("established evidence");
  expect(dashboard.maximumHintLevel).toBe(1);
  expect(dashboard.hintReliance).toEqual({
    assistedAttempts: 1,
    totalAttempts: 4,
  });
  expect(dashboard.confidenceMeanAbsoluteError).toBe(40);
  expect(dashboard.confidenceCalibration).toEqual([
    {
      range: "0–24",
      attempts: 1,
      meanConfidence: 20,
      fullyCorrectRate: 1,
    },
    {
      range: "25–49",
      attempts: 1,
      meanConfidence: 40,
      fullyCorrectRate: 0,
    },
    {
      range: "50–74",
      attempts: 1,
      meanConfidence: 70,
      fullyCorrectRate: 1,
    },
    {
      range: "75–100",
      attempts: 1,
      meanConfidence: 90,
      fullyCorrectRate: 1,
    },
  ]);
  expect(dashboard.misconceptions).toEqual([
    { conceptId: "kinematics", text: "Acceleration changes velocity." },
  ]);
});

test("excludes ungradable attempts from calibration and unaided evidence", async () => {
  const { course, question } = await createApplicationFixture();
  const history = {
    schemaVersion: 2 as const,
    courseId: course.id,
    revision: 0,
    appliedOperationIds: [],
    concepts: {},
    attempts: [
      {
        id: "attempt-1",
        operationId: "operation-1",
        kind: "answered" as const,
        question,
        mode: "study" as const,
        submittedAt: now.toISOString(),
        answer: "answer",
        confidence: 100,
        unaidedAtSubmission: true,
        highestHintLevel: 0 as const,
        revealed: false,
        correctness: "correct" as const,
      },
      {
        id: "attempt-2",
        operationId: "operation-2",
        kind: "answered" as const,
        question,
        mode: "study" as const,
        submittedAt: now.toISOString(),
        answer: "answer",
        confidence: 0,
        unaidedAtSubmission: true,
        highestHintLevel: 0 as const,
        revealed: false,
        correctness: "ungradable" as const,
      },
    ],
  };

  const dashboard = buildDashboard(course, history, now);

  expect(dashboard.unaidedCorrectRetrievalCount).toBe(1);
  expect(dashboard.unaidedEvidence).toBe("emerging");
  expect(dashboard.confidenceMeanAbsoluteError).toBe(0);
  expect(dashboard.confidenceCalibration[0]).toEqual({
    range: "0–24",
    attempts: 0,
  });
  expect(dashboard.confidenceCalibration[3]).toEqual({
    range: "75–100",
    attempts: 1,
    meanConfidence: 100,
    fullyCorrectRate: 1,
  });
});

test("exports the regular-learning application service", () => {
  expect(LearningService).toBeTypeOf("function");
});

test("starts a regular mode through learning use cases", async () => {
  const { app, course } = await createApplicationFixture();

  await expect(app.requestMode(course.id, "review")).resolves.toMatchObject({
    state: { tag: "awaiting-question", mode: "review", courseId: course.id },
  });
});
