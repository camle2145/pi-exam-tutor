import { expect, test } from "vitest";
import { ActivityCodec } from "../../src/application/activity-codec.js";
import { createApplicationFixture, now } from "./setup.js";

test("restores an activity snapshot without losing global course evidence", async () => {
  const { app, course, store, question } = await createApplicationFixture();
  const activity = await app.acceptSubmission(
    await app.recordQuestion(
      await app.requestMode(course.id, "study"),
      question,
    ),
    { answer: "velocity increases", confidence: 80 },
  );

  const snapshot = app.serializeActivity(activity);
  const restored = app.restoreActivity(snapshot);

  expect(restored).toEqual(activity);
  expect((await store.getHistory(course.id)).attempts).toHaveLength(1);
});

test("restores a valid exam-generating activity snapshot", async () => {
  const { app, course } = await createApplicationFixture();
  const activity = await app.requestMode(course.id, "exam");

  expect(app.restoreActivity(app.serializeActivity(activity))).toEqual(
    activity,
  );
});

test("restores an active exam independently of learning-history schema migration", async () => {
  const { app, course } = await createApplicationFixture();
  const activeExam = {
    schemaVersion: 1 as const,
    state: {
      tag: "exam-active" as const,
      courseId: course.id,
      exam: {
        id: "exam-1",
        operationId: "op-exam",
        startedAt: now.toISOString(),
        status: "active" as const,
        items: [],
        drafts: {},
      },
    },
  };

  expect(() => app.restoreActivity(JSON.stringify(activeExam))).not.toThrow();
});

test("rejects adversarial activity snapshots before restoring them", async () => {
  const { app } = await createApplicationFixture();

  expect(() =>
    app.restoreActivity(
      JSON.stringify({ schemaVersion: 1, state: { tag: "bad" } }),
    ),
  ).toThrow("Invalid activity snapshot");
  expect(() =>
    app.restoreActivity(
      JSON.stringify({
        schemaVersion: 1,
        state: {
          tag: "awaiting-primary-answer",
          courseId: "course-1",
          mode: "exam",
          question: { id: "question-1" },
          hintLevel: 7,
          revealed: "false",
        },
      }),
    ),
  ).toThrow("Invalid activity snapshot");
});

test("restores a detached activity copy", async () => {
  const { app, course } = await createApplicationFixture();
  const activeExam = {
    schemaVersion: 1 as const,
    state: {
      tag: "exam-active" as const,
      courseId: course.id,
      exam: {
        id: "exam-detached",
        operationId: "op-exam-detached",
        startedAt: now.toISOString(),
        status: "active" as const,
        items: [],
        drafts: {},
      },
    },
  };

  const snapshot = JSON.stringify(activeExam);
  const restored = app.restoreActivity(snapshot);
  expect(restored).toEqual(activeExam);
  expect(restored).not.toBe(activeExam);
  expect(restored.state).not.toBe(activeExam.state);
});

test("rejects malformed restored exam drafts without recording evidence", async () => {
  const { app, course, store } = await createApplicationFixture();
  const activity = await app.requestMode(course.id, "exam");
  const malformed = {
    schemaVersion: 1,
    state: {
      tag: "exam-submitted" as const,
      courseId: course.id,
      exam: {
        id: "exam-malformed",
        operationId: "exam-operation-malformed",
        startedAt: now.toISOString(),
        status: "submitted" as const,
        items: [],
        drafts: {
          missing: {
            answer: "Answer.",
            confidence: 80,
            submittedAt: now.toISOString(),
          },
        },
      },
    },
  };

  expect(() => app.restoreActivity(JSON.stringify(malformed))).toThrow(
    "Invalid activity snapshot",
  );
  expect((await store.getHistory(course.id)).attempts).toEqual([]);
  expect(activity.state.tag).toBe("exam-generating");
});

test("rejects malformed exam submission states before they can be restored or graded", async () => {
  const { app, course, store } = await createApplicationFixture();
  const malformed = {
    schemaVersion: 1,
    state: {
      tag: "exam-submitted",
      courseId: course.id,
      exam: {
        id: "exam-invalid-boundary",
        operationId: "operation-invalid-boundary",
        startedAt: now.toISOString(),
        status: "active",
        items: [],
        drafts: {},
      },
    },
  };

  expect(() => app.restoreActivity(JSON.stringify(malformed))).toThrow(
    "Invalid activity snapshot",
  );
  expect(() =>
    app.restoreActivity(
      JSON.stringify({
        ...malformed,
        state: {
          ...malformed.state,
          tag: "exam-active",
          exam: {
            ...malformed.state.exam,
            status: "submitted",
            submittedAt: now.toISOString(),
          },
        },
      }),
    ),
  ).toThrow("Invalid activity snapshot");
  await expect(app.recordExamGrades(malformed, [])).rejects.toThrow(
    "Invalid activity snapshot",
  );
  expect((await store.getHistory(course.id)).attempts).toEqual([]);
});
