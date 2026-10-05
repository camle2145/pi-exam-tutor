import { vi } from "vitest";
import type { ExamTutorAdapterDependencies } from "../../extensions/exam-tutor/index.js";
import type { TutorApplication } from "../../src/application.js";
import type {
  Course,
  CourseConceptProposal,
  Dashboard,
  ExamGrade,
  ExamSession,
  Question,
  SessionActivity,
} from "../../src/domain.js";
import type { Store } from "../../src/storage.js";

export const now = new Date("2026-08-27T09:00:00.000Z");
export const course: Course = {
  schemaVersion: 1,
  id: "course-1",
  name: "Physics",
  revision: 1,
  createdAt: now.toISOString(),
  appliedOperationIds: [],
  partialAnswerPolicy: "remediate",
  materials: [
    {
      id: "material-1",
      path: "/courses/physics/notes.md",
      addedAt: now.toISOString(),
    },
  ],
  concepts: [{ id: "kinematics", name: "Kinematics" }],
  proposedConcepts: [],
};
export const question: Question = {
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
export const exam: ExamSession = {
  id: "exam-1",
  operationId: "operation-1",
  startedAt: now.toISOString(),
  status: "active",
  items: [
    {
      id: "1",
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
  drafts: {},
};
export const twoExamItems: Question[] = [
  exam.items[0]!,
  {
    ...exam.items[0]!,
    id: "2",
    prompt: "second prompt",
  },
];
export const generatingExam: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "exam-generating",
    courseId: course.id,
    operationId: "operation-1",
    startedAt: now.toISOString(),
  },
};
export const conceptProposal: CourseConceptProposal = {
  id: "newton-laws",
  name: "Newton's laws",
  sourceRefs: [
    {
      materialId: "material-1",
      path: "/courses/physics/notes.md",
      locator: "# laws",
    },
  ],
};
export const examGrade: ExamGrade = {
  questionId: "exam-question-id",
  correctness: "correct",
  gradingRationale: "Complete.",
};
export const examWithActualId: ExamSession = {
  ...exam,
  items: [{ ...exam.items[0]!, id: "exam-question-id" }],
  drafts: {
    "exam-question-id": {
      answer: "Acceleration changes velocity.",
      confidence: 80,
      submittedAt: now.toISOString(),
    },
  },
};
export const activeExamWithAllDrafts: SessionActivity = {
  schemaVersion: 1,
  state: { tag: "exam-active", courseId: course.id, exam: examWithActualId },
};
export const submittedExam: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "exam-submitted",
    courseId: course.id,
    exam: {
      ...examWithActualId,
      status: "submitted",
      submittedAt: now.toISOString(),
    },
  },
};
export const idle: SessionActivity = {
  schemaVersion: 1,
  state: { tag: "idle", courseId: course.id },
};
export const activeExam: SessionActivity = {
  schemaVersion: 1,
  state: { tag: "exam-active", courseId: course.id, exam },
};
export const awaitingAnswer: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "awaiting-primary-answer",
    courseId: course.id,
    mode: "study",
    question,
    hintLevel: 0,
    revealed: false,
  },
};
export const awaitingGrade: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "awaiting-grade",
    courseId: course.id,
    mode: "study",
    attemptId: "attempt-1",
    purpose: "primary",
    question,
    hintLevel: 0,
  },
};

export function createExtensionDependencies(
  overrides: Partial<TutorApplication> = {},
): ExamTutorAdapterDependencies & { app: TutorApplication } {
  const app = {
    createCourse: vi.fn(async () => course),
    selectCourse: vi.fn(async () => idle),
    addMaterial: vi.fn(async () => course),
    requestMode: vi.fn(async () => idle),
    recordQuestion: vi.fn(async () => idle),
    acceptSubmission: vi.fn(async () => idle),
    requestHint: vi.fn(async () => idle),
    recordHint: vi.fn(async () => idle),
    requestReveal: vi.fn(async () => idle),
    recordSolution: vi.fn(async () => idle),
    recordGrade: vi.fn(async () => idle),
    recordExplanation: vi.fn(async () => idle),
    recordExam: vi.fn(async () => activeExam),
    submitExam: vi.fn(async () => idle),
    proposeConcepts: vi.fn(async () => ({
      ...course,
      proposedConcepts: [conceptProposal],
    })),
    approveConcepts: vi.fn(async () => course),
    editProposedConcept: vi.fn(async () => course),
    removeProposedConcept: vi.fn(async () => course),
    recordExamGrades: vi.fn(async () => idle),
    serializeActivity: vi.fn((activity: SessionActivity) =>
      JSON.stringify(activity),
    ),
    restoreActivity: vi.fn((snapshot: string) => JSON.parse(snapshot)),
    ...overrides,
  } as TutorApplication;
  const dashboard: Dashboard = {
    courseId: course.id,
    dueUnassisted: [],
    dueAssisted: [],
    unaidedCorrectRetrievalCount: 0,
    unaidedEvidence: "not demonstrated",
    confidenceCalibration: [
      { range: "0–24", attempts: 0 },
      { range: "25–49", attempts: 0 },
      { range: "50–74", attempts: 0 },
      { range: "75–100", attempts: 0 },
    ],
    maximumHintLevel: 0,
    hintReliance: { assistedAttempts: 0, totalAttempts: 0 },
    misconceptions: [],
    unansweredExamItems: [],
  };
  const store = {
    listCourses: vi.fn(async () => [course]),
    getCourse: vi.fn(async () => course),
    getHistory: vi.fn(async () => ({
      schemaVersion: 1 as const,
      courseId: course.id,
      revision: 0,
      appliedOperationIds: [],
      attempts: [],
      concepts: {},
    })),
  } as unknown as Store;
  return {
    app,
    store,
    clock: { now: () => new Date(now) },
    buildDashboard: vi.fn(() => dashboard),
  };
}
