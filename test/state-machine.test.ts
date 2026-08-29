import { expect, test } from "vitest";
import {
  assertCourseInvariant,
  assertQuestion,
  type ActivityState,
  type Course,
  type ExamSession,
  type Question,
} from "../src/domain.js";
import { transition } from "../src/state-machine.js";

const course: Course = {
  schemaVersion: 1,
  id: "course-1",
  name: "Physics",
  revision: 0,
  createdAt: "2026-08-27T09:00:00.000Z",
  appliedOperationIds: [],
  partialAnswerPolicy: "remediate",
  materials: [
    {
      id: "material-1",
      path: "/courses/physics/notes.md",
      addedAt: "2026-08-27T09:00:00.000Z",
    },
  ],
  concepts: [{ id: "kinematics", name: "Kinematics" }],
  proposedConcepts: [],
};

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

const transferQuestion: Question = {
  ...question,
  id: "question-2",
  kind: "transfer",
};

const awaitingAnswer: ActivityState = {
  tag: "awaiting-primary-answer",
  courseId: "course-1",
  mode: "study",
  question,
  hintLevel: 0,
  revealed: false,
};

const exam: ExamSession = {
  id: "exam-1",
  operationId: "op-exam",
  startedAt: "2026-08-27T09:00:00.000Z",
  status: "active",
  items: [{ ...question, id: "exam-question", kind: "exam" }],
  drafts: {},
};

const examActive: ActivityState = {
  tag: "exam-active",
  courseId: "course-1",
  exam,
};

test("rejects a question that targets no configured concept", () => {
  expect(() =>
    assertQuestion(course, { ...question, targetConceptId: "missing" }),
  ).toThrow("Unknown target concept: missing");
});

test("rejects a source path outside the selected course", () => {
  expect(() =>
    assertQuestion(course, {
      ...question,
      sourceRefs: [
        { materialId: "material-1", path: "/tmp/outside.md", locator: "# x" },
      ],
    }),
  ).toThrow("Source path is not configured for this course");
});

test("rejects duplicate material paths", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      materials: [
        ...course.materials,
        {
          id: "material-2",
          path: "/courses/physics/notes.md",
          addedAt: "2026-08-27T09:00:00.000Z",
        },
      ],
    }),
  ).toThrow("Duplicate material path: /courses/physics/notes.md");
});

test("rejects duplicate concept identifiers", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      concepts: [...course.concepts, { id: "kinematics", name: "Motion" }],
    }),
  ).toThrow("Duplicate concept id: kinematics");
});

test("rejects a non-normalized material path", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      materials: [
        {
          ...course.materials[0]!,
          path: "/courses/physics/../physics/notes.md",
        },
      ],
    }),
  ).toThrow("Material path must be absolute and normalized");
});

test("rejects an invalid partial-answer policy", () => {
  expect(() =>
    assertCourseInvariant({ ...course, partialAnswerPolicy: "skip" as never }),
  ).toThrow("Invalid partial answer policy");
});

test("starts non-exam modes and presents a primary question", () => {
  const requested = transition(
    { tag: "idle", courseId: "course-1" },
    {
      type: "modeRequested",
      mode: "review",
      operationId: "op-review",
      startedAt: "2026-08-27T09:00:00.000Z",
    },
  );

  expect(requested).toEqual({
    tag: "awaiting-question",
    courseId: "course-1",
    mode: "review",
    operationId: "op-review",
  });
  expect(
    transition(requested, { type: "questionPresented", question }),
  ).toEqual({
    ...awaitingAnswer,
    mode: "review",
  });
});

test("enforces sequential hints", () => {
  const requested = transition(awaitingAnswer, { type: "hintRequested" });
  expect(requested.tag).toBe("hint-requested");
  expect(() =>
    transition(requested, { type: "hintPresented", level: 2 }),
  ).toThrow("Expected hint level 1");
  expect(transition(requested, { type: "hintPresented", level: 1 })).toEqual({
    ...awaitingAnswer,
    hintLevel: 1,
  });
});

test("does not offer a seventh hint or hints for transfer questions", () => {
  expect(() =>
    transition({ ...awaitingAnswer, hintLevel: 6 }, { type: "hintRequested" }),
  ).toThrow("All hints have already been presented");
  expect(() =>
    transition(
      { ...awaitingAnswer, question: transferQuestion },
      { type: "hintRequested" },
    ),
  ).toThrow("Hints are unavailable for a transfer question");
});

test("requires explanation and transfer after reveal", () => {
  const reveal = transition(awaitingAnswer, { type: "revealRequested" });
  const explain = transition(reveal, {
    type: "solutionPresented",
    attemptId: "a-revealed",
  });
  expect(explain).toMatchObject({
    tag: "awaiting-explanation",
    attemptId: "a-revealed",
    reason: "reveal",
  });
  const transfer = transition(explain, {
    type: "explanationAccepted",
    attemptId: "a-explanation",
    operationId: "op-transfer",
  });
  expect(transfer).toEqual({
    tag: "awaiting-transfer",
    courseId: "course-1",
    mode: "study",
    parentAttemptId: "a-explanation",
    operationId: "op-transfer",
  });
  expect(() => transition(transfer, { type: "hintRequested" })).toThrow();
  expect(() => transition(transfer, { type: "revealRequested" })).toThrow();
  expect(
    transition(transfer, {
      type: "questionPresented",
      question: transferQuestion,
    }),
  ).toEqual({
    ...awaitingAnswer,
    question: transferQuestion,
  });
});

test("requires correction, explanation, and transfer for incorrect answers", () => {
  const grading = transition(awaitingAnswer, {
    type: "submissionAccepted",
    attemptId: "a-primary",
  });
  const correction = transition(grading, {
    type: "gradeRecorded",
    correctness: "incorrect",
    assisted: false,
    partialAnswerPolicy: "continue",
  });
  expect(correction).toMatchObject({
    tag: "awaiting-correction",
    attemptId: "a-primary",
    mode: "study",
  });

  const explanation = transition(correction, {
    type: "submissionAccepted",
    attemptId: "a-correction",
  });
  expect(explanation).toMatchObject({
    tag: "awaiting-explanation",
    attemptId: "a-correction",
    reason: "error",
    mode: "study",
  });
  expect(() =>
    transition(explanation, {
      type: "submissionAccepted",
      attemptId: "a-again",
    }),
  ).toThrow();
});

test("applies the selected partial-answer policy", () => {
  const grading = transition(awaitingAnswer, {
    type: "submissionAccepted",
    attemptId: "a-primary",
  });

  expect(
    transition(grading, {
      type: "gradeRecorded",
      correctness: "partial",
      assisted: false,
      partialAnswerPolicy: "continue",
      nextOperationId: "op-next",
    }),
  ).toEqual({
    tag: "awaiting-question",
    courseId: "course-1",
    mode: "study",
    operationId: "op-next",
  });
  expect(
    transition(grading, {
      type: "gradeRecorded",
      correctness: "partial",
      assisted: false,
      partialAnswerPolicy: "remediate",
    }),
  ).toMatchObject({ tag: "awaiting-correction", attemptId: "a-primary" });
});

test("continues after correct and ungradable grades with the supplied operation ID", () => {
  const grading = transition(awaitingAnswer, {
    type: "submissionAccepted",
    attemptId: "a-primary",
  });

  for (const correctness of ["correct", "ungradable"] as const) {
    expect(
      transition(grading, {
        type: "gradeRecorded",
        correctness,
        assisted: correctness === "correct",
        partialAnswerPolicy: "remediate",
        nextOperationId: `op-${correctness}`,
      }),
    ).toEqual({
      tag: "awaiting-question",
      courseId: "course-1",
      mode: "study",
      operationId: `op-${correctness}`,
    });
  }
});

test("starts and completes an exam lifecycle without per-question feedback", () => {
  const generating = transition(
    { tag: "idle", courseId: "course-1" },
    {
      type: "modeRequested",
      mode: "exam",
      operationId: "op-exam",
      startedAt: "2026-08-27T09:00:00.000Z",
      deadlineAt: "2026-08-27T10:00:00.000Z",
    },
  );
  expect(generating).toMatchObject({ tag: "exam-generating" });
  const active = transition(generating, { type: "examPresented", exam });
  const draft = {
    answer: "velocity increases",
    confidence: 0.8,
    submittedAt: "2026-08-27T09:15:00.000Z",
  };
  const drafted = transition(active, {
    type: "examDraftAccepted",
    questionId: "exam-question",
    draft,
  });

  expect(drafted).toEqual({
    ...examActive,
    exam: { ...exam, drafts: { "exam-question": draft } },
  });
  expect(() =>
    transition(drafted, {
      type: "gradeRecorded",
      correctness: "correct",
      assisted: false,
      partialAnswerPolicy: "remediate",
      nextOperationId: "op-next",
    }),
  ).toThrow();
  expect(() => transition(drafted, { type: "hintRequested" })).toThrow(
    "Hints are unavailable during an exam",
  );
  expect(() => transition(drafted, { type: "revealRequested" })).toThrow(
    "Reveal is unavailable during an exam",
  );
  expect(() =>
    transition(drafted, {
      type: "examDraftAccepted",
      questionId: "missing",
      draft,
    }),
  ).toThrow("Unknown exam question: missing");

  const submitted = transition(drafted, {
    type: "examSubmitted",
    submittedAt: "2026-08-27T10:00:00.000Z",
    expired: true,
  });
  expect(submitted).toMatchObject({
    tag: "exam-submitted",
    exam: { status: "expired", submittedAt: "2026-08-27T10:00:00.000Z" },
  });
  expect(transition(submitted, { type: "examGraded" })).toMatchObject({
    tag: "exam-submitted",
    exam: { status: "graded" },
  });
  expect(
    transition(active, {
      type: "examSubmitted",
      submittedAt: "2026-08-27T09:30:00.000Z",
      expired: false,
    }),
  ).toMatchObject({ tag: "exam-submitted", exam: { status: "submitted" } });
});

test("rejects unsupported event and state pairs", () => {
  expect(() =>
    transition(
      { tag: "idle", courseId: "course-1" },
      { type: "hintRequested" },
    ),
  ).toThrow("Unsupported transition: idle + hintRequested");
  expect(() =>
    transition(examActive, { type: "questionPresented", question }),
  ).toThrow("Unsupported transition: exam-active + questionPresented");
});
