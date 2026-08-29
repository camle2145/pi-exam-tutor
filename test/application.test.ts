import { expect, test } from "vitest";
import { type Course, type Question } from "../src/domain.js";
import { TutorApplicationService } from "../src/application.js";
import { buildDashboard } from "../src/dashboard.js";
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

test("restores a valid exam-generating activity snapshot", async () => {
  const { app, course } = await createApp();
  const activity = await app.requestMode(course.id, "exam");

  expect(app.restoreActivity(app.serializeActivity(activity))).toEqual(
    activity,
  );
});

test("rejects adversarial activity snapshots before restoring them", async () => {
  const { app } = await createApp();

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

test("records a model-delivered reveal solution before requesting explanation", async () => {
  const { app, course, store, question } = await createApp();
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
  const { app, course, store, question } = await createApp();
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
  const { course, question } = await createApp();
  const history = {
    schemaVersion: 1 as const,
    courseId: course.id,
    revision: 0,
    appliedOperationIds: [],
    concepts: {},
    attempts: [
      {
        id: "attempt-1",
        operationId: "operation-1",
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

test("selects an existing course as an idle activity", async () => {
  const { app, course } = await createApp();

  await expect(
    app.selectCourse(course.id, { schemaVersion: 1, state: { tag: "idle" } }),
  ).resolves.toEqual({
    schemaVersion: 1,
    state: { tag: "idle", courseId: course.id },
  });
});

test("keeps extracted concepts pending until a learner approves them", async () => {
  const { app, course } = await createApp();
  const sourceRefs = [
    {
      materialId: "material-1",
      path: "/courses/physics/notes.md",
      locator: "# newton-laws",
    },
  ];

  const proposed = await app.proposeConcepts(course.id, [
    { id: "newton-laws", name: "Newton's laws", sourceRefs },
  ]);
  expect(proposed.concepts).toEqual([{ id: "kinematics", name: "Kinematics" }]);
  expect(proposed.proposedConcepts).toHaveLength(1);

  const approved = await app.approveConcepts(course.id, ["newton-laws"]);
  expect(approved.concepts).toMatchObject([
    { id: "kinematics", name: "Kinematics" },
    { id: "newton-laws", name: "Newton's laws" },
  ]);
  expect(approved.proposedConcepts).toEqual([]);
});

test("rejects a concept proposal whose source is not configured", async () => {
  const { app, course } = await createApp();

  await expect(
    app.proposeConcepts(course.id, [
      {
        id: "bad",
        name: "Bad",
        sourceRefs: [
          { materialId: "missing", path: "/tmp/missing.md", locator: "# x" },
        ],
      },
    ]),
  ).rejects.toThrow("Unknown source material: missing");
});

test("records a complete submitted exam as independently scheduled evidence", async () => {
  const { app, course, store } = await createApp();
  const examQuestion = {
    id: "exam-q-1",
    kind: "exam" as const,
    targetConceptId: "kinematics",
    prompt: "Explain acceleration.",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/physics/notes.md",
        locator: "# acceleration",
      },
    ],
  };
  const presented = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-1",
      operationId: "exam-operation-1",
      startedAt: now.toISOString(),
      status: "active",
      items: [examQuestion],
      drafts: {
        "exam-q-1": {
          answer: "Acceleration changes velocity.",
          confidence: 80,
          submittedAt: now.toISOString(),
        },
      },
    },
  );
  const submitted = await app.submitExam(presented);

  const next = await app.recordExamGrades(submitted, [
    {
      questionId: "exam-q-1",
      correctness: "correct",
      gradingRationale: "Complete",
    },
  ]);

  expect(next.state).toMatchObject({
    tag: "exam-submitted",
    exam: { status: "graded" },
  });
  expect((await store.getHistory(course.id)).attempts).toMatchObject([
    {
      question: { id: "exam-q-1" },
      mode: "exam",
      unaidedAtSubmission: true,
      correctness: "correct",
    },
  ]);
});

test("records all aggregate exam attempts with one operation ID", async () => {
  const { app, course, store } = await createApp();
  const examQuestions = ["one", "two"].map((id) => ({
    id,
    kind: "exam" as const,
    targetConceptId: "kinematics",
    prompt: `Explain ${id}.`,
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/physics/notes.md",
        locator: `# ${id}`,
      },
    ],
  }));
  const presented = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-aggregate",
      operationId: "exam-operation-aggregate",
      startedAt: now.toISOString(),
      status: "active",
      items: examQuestions,
      drafts: Object.fromEntries(
        examQuestions.map(({ id }) => [
          id,
          {
            answer: `Answer ${id}.`,
            confidence: 80,
            submittedAt: now.toISOString(),
          },
        ]),
      ),
    },
  );

  await app.recordExamGrades(await app.submitExam(presented), [
    { questionId: "one", correctness: "correct", gradingRationale: "Complete" },
    {
      questionId: "two",
      correctness: "partial",
      gradingRationale: "Mostly complete",
    },
  ]);

  const history = await store.getHistory(course.id);
  const operationIds = new Set(
    history.attempts.map(({ operationId }) => operationId),
  );
  expect([...operationIds]).toHaveLength(1);
  expect(history.appliedOperationIds).toEqual([...operationIds]);
});

test("rejects malformed restored exam drafts without recording evidence", async () => {
  const { app, course, store } = await createApp();
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

test("revalidates restored exam questions before recording evidence", async () => {
  const { app, course, store } = await createApp();
  const presented = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-restored",
      operationId: "exam-operation-restored",
      startedAt: now.toISOString(),
      status: "active",
      items: [
        {
          id: "exam-q",
          kind: "exam",
          targetConceptId: "kinematics",
          prompt: "Explain acceleration.",
          sourceRefs: [
            {
              materialId: "material-1",
              path: "/courses/physics/notes.md",
              locator: "# acceleration",
            },
          ],
        },
      ],
      drafts: {
        "exam-q": {
          answer: "Acceleration changes velocity.",
          confidence: 80,
          submittedAt: now.toISOString(),
        },
      },
    },
  );
  const submitted = await app.submitExam(presented);
  const restored = {
    ...submitted,
    state: {
      ...submitted.state,
      exam: {
        ...submitted.state.exam,
        items: submitted.state.exam.items.map((question) => ({
          ...question,
          sourceRefs: [
            { ...question.sourceRefs[0]!, path: "/outside/course.md" },
          ],
        })),
      },
    },
  };

  await expect(
    app.recordExamGrades(restored, [
      {
        questionId: "exam-q",
        correctness: "correct",
        gradingRationale: "Complete",
      },
    ]),
  ).rejects.toThrow("Source path is not configured for this course");
  expect((await store.getHistory(course.id)).attempts).toEqual([]);
});

test("rejects aggregate grades that do not exactly cover submitted drafts", async () => {
  const { app, course } = await createApp();
  const examQuestion = {
    id: "exam-q-1",
    kind: "exam" as const,
    targetConceptId: "kinematics",
    prompt: "Explain acceleration.",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/physics/notes.md",
        locator: "# acceleration",
      },
    ],
  };
  const presented = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-1",
      operationId: "exam-operation-1",
      startedAt: now.toISOString(),
      status: "active",
      items: [examQuestion],
      drafts: {
        "exam-q-1": {
          answer: "Acceleration changes velocity.",
          confidence: 80,
          submittedAt: now.toISOString(),
        },
      },
    },
  );

  await expect(
    app.recordExamGrades(await app.submitExam(presented), []),
  ).rejects.toThrow("Exam grades must exactly cover submitted drafts");
});

test("clears a pending concept parent only when explicitly requested", async () => {
  const { app, course } = await createApp();
  const proposed = await app.proposeConcepts(course.id, [
    {
      id: "laws",
      name: "Laws",
      sourceRefs: [
        {
          materialId: "material-1",
          path: "/courses/physics/notes.md",
          locator: "# laws",
        },
      ],
    },
    {
      id: "impulse",
      name: "Impulse",
      parentId: "laws",
      sourceRefs: [
        {
          materialId: "material-1",
          path: "/courses/physics/notes.md",
          locator: "# impulse",
        },
      ],
    },
  ]);

  const cleared = await app.editProposedConcept(course.id, "impulse", {
    parentId: null,
  });

  expect(
    proposed.proposedConcepts.find(({ id }) => id === "impulse")?.parentId,
  ).toBe("laws");
  expect(
    cleared.proposedConcepts.find(({ id }) => id === "impulse")?.parentId,
  ).toBeUndefined();
});
