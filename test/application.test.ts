import { expect, test } from "vitest";
import { type Course, type Question } from "../src/domain.js";
import { TutorApplicationService } from "../src/application.js";
import { FakeClock, SequenceIds, tempRoot } from "./helpers.js";
import { LocalStore } from "../src/storage.js";

const now = new Date("2026-08-27T09:00:00.000Z");

async function createApp(): Promise<{
  app: TutorApplicationService;
  course: Course;
  store: LocalStore;
  question: Question;
}> {
  const ids = new SequenceIds();
  const store = new LocalStore(await tempRoot(), ids);
  const app = new TutorApplicationService(store, new FakeClock(now), ids);
  const created = await app.createCourse("Physics");
  const course = await store.saveCourse(
    {
      ...created,
      revision: created.revision + 1,
      materials: [
        {
          id: "material-1",
          path: "/courses/physics/notes.md",
          addedAt: now.toISOString(),
        },
      ],
      concepts: [{ id: "kinematics", name: "Kinematics" }],
    },
    created.revision,
    "configure-course",
  );
  const question: Question = {
    id: "question-1",
    kind: "primary",
    targetConceptId: "kinematics",
    prompt: "How does acceleration affect velocity?",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/physics/notes.md",
        locator: "# acceleration",
      },
    ],
  };

  return { app, course, store, question };
}

test("assisted correctness cannot create unassisted mastery evidence", async () => {
  const { app, course, store, question } = await createApp();
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

test("records a branch retry instead of overwriting the original attempt", async () => {
  const { app, course, store, question } = await createApp();
  const activity = await app.recordQuestion(
    await app.requestMode(course.id, "study"),
    question,
  );

  await app.acceptSubmission(activity, { answer: "x", confidence: 50 });
  await app.acceptSubmission(activity, { answer: "x", confidence: 50 });

  const attempts = (await store.getHistory(course.id)).attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.retryOfAttemptId).toBe(attempts[0]?.id);
  expect(attempts[0]?.retryOfAttemptId).toBeUndefined();
});

test("persists incorrect unaided evidence before requiring correction", async () => {
  const { app, course, store, question } = await createApp();
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

test("restores an activity snapshot without losing global course evidence", async () => {
  const { app, course, store, question } = await createApp();
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

test("selects an existing course as an idle activity", async () => {
  const { app, course } = await createApp();

  await expect(
    app.selectCourse(course.id, { schemaVersion: 1, state: { tag: "idle" } }),
  ).resolves.toEqual({
    schemaVersion: 1,
    state: { tag: "idle", courseId: course.id },
  });
});
