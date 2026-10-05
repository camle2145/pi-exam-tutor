import { expect, test } from "vitest";
import { TutorApplicationService } from "../../src/application.js";
import { createApplicationFixture, now } from "./setup.js";

async function activeExamFor() {
  const { app, course, question, store } = await createApplicationFixture();
  const active = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-1",
      operationId: "exam-operation-1",
      startedAt: now.toISOString(),
      status: "active",
      items: [{ ...question, id: "exam-question-1", kind: "exam" }],
      drafts: {},
    },
  );
  return { active, app, course, store };
}

test("saves an exam draft through the application facade without history writes", async () => {
  const { active, app, course, store } = await activeExamFor();

  const next = await app.saveExamDraft(active, "exam-question-1", {
    answer: "Acceleration changes velocity.",
    confidence: 70,
    submittedAt: now.toISOString(),
  });

  expect(next.state).toMatchObject({
    tag: "exam-active",
    exam: { drafts: { "exam-question-1": { confidence: 70 } } },
  });
  expect((await store.getHistory(course.id)).attempts).toEqual([]);
});

test("records each manually omitted exam item before model grading", async () => {
  const { app, course, store } = await createApplicationFixture();
  const submitted = await app.submitExam(
    await activeExamWithDrafts(app, course.id, ["one"]),
  );
  const attempts = (await store.getHistory(course.id)).attempts;

  expect(submitted.state).toMatchObject({ tag: "exam-submitted" });
  expect(attempts).toContainEqual(
    expect.objectContaining({
      kind: "unanswered",
      question: expect.objectContaining({ id: "two" }),
      omissionReason: "manual-partial",
    }),
  );
});

test("applies only one Again review per concept for multiple omitted items", async () => {
  const { app, course, store } = await createApplicationFixture();
  await app.submitExam(await activeExamWithDrafts(app, course.id, []));

  const track = (await store.getHistory(course.id)).concepts.kinematics!
    .unassisted!;
  expect(track.reviewHistory).toHaveLength(1);
  expect(track.reviewHistory[0]).toMatchObject({ rating: "Again" });
});

test("grades only drafts after omissions are recorded", async () => {
  const { app, course, store } = await createApplicationFixture();
  const submitted = await app.submitExam(
    await activeExamWithDrafts(app, course.id, ["one"]),
  );
  await app.recordExamGrades(submitted, [
    {
      questionId: "one",
      correctness: "correct",
      gradingRationale: "Complete",
    },
  ]);

  expect((await store.getHistory(course.id)).attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unanswered",
        question: expect.objectContaining({ id: "two" }),
      }),
      expect.objectContaining({
        kind: "answered",
        question: expect.objectContaining({ id: "one" }),
      }),
    ]),
  );
});

test("labels deadline omissions and still grades saved drafts later", async () => {
  const { app, clock, course, store } = await createApplicationFixture();
  const timed = await activeExamWithDrafts(app, course.id, ["one"], {
    deadlineAt: "2026-08-27T10:00:00.000Z",
  });
  clock.set(new Date("2026-08-27T10:01:00.000Z"));
  const submitted = await app.submitExam(timed);

  expect((await store.getHistory(course.id)).attempts).toContainEqual(
    expect.objectContaining({ omissionReason: "deadline" }),
  );
  await expect(
    app.recordExamGrades(submitted, [
      {
        questionId: "one",
        correctness: "correct",
        gradingRationale: "Complete",
      },
    ]),
  ).resolves.toMatchObject({ state: { exam: { status: "graded" } } });
});

test("records a complete submitted exam as independently scheduled evidence", async () => {
  const { app, course, store } = await createApplicationFixture();
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
  const { app, course, store } = await createApplicationFixture();
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

test("revalidates restored exam questions before recording evidence", async () => {
  const { app, course, store } = await createApplicationFixture();
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
  const { app, course } = await createApplicationFixture();
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

test("rejects duplicate exam question IDs before activating an exam", async () => {
  const { app, course, question } = await createApplicationFixture();
  const examQuestion = { ...question, id: "duplicate", kind: "exam" as const };

  await expect(
    app.recordExam(await app.requestMode(course.id, "exam"), {
      id: "exam-duplicates",
      operationId: "operation-duplicates",
      startedAt: now.toISOString(),
      status: "active",
      items: [examQuestion, examQuestion],
      drafts: {},
    }),
  ).rejects.toThrow("Duplicate exam question id: duplicate");
});

test("rejects unsafe exam question IDs before activating an exam", async () => {
  const { app, course, question } = await createApplicationFixture();

  for (const id of ["", "line\nbreak", "__proto__"]) {
    await expect(
      app.recordExam(await app.requestMode(course.id, "exam"), {
        id: "exam-unsafe-id",
        operationId: "operation-unsafe-id",
        startedAt: now.toISOString(),
        status: "active",
        items: [{ ...question, id, kind: "exam" }],
        drafts: {},
      }),
    ).rejects.toThrow("Exam question ID is not safe for draft syntax");
  }
});

async function activeExamWithDrafts(
  app: TutorApplicationService,
  courseId: string,
  draftIds: readonly string[],
  options: { deadlineAt?: string } = {},
) {
  const items = ["one", "two"].map((id) => ({
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
  const mode = await app.requestMode(courseId, "exam", options);
  return app.recordExam(mode, {
    id: "exam-omissions",
    operationId: "exam-operation-omissions",
    startedAt: now.toISOString(),
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    status: "active",
    items,
    drafts: Object.fromEntries(
      draftIds.map((id) => [
        id,
        {
          answer: `Answer ${id}.`,
          confidence: 80,
          submittedAt: now.toISOString(),
        },
      ]),
    ),
  });
}
