import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TutorApplication } from "../../src/application.js";
import type {
  ActivityState,
  CourseConceptProposal,
  ExamGrade,
  ExamSession,
  HintLevel,
  Question,
  SessionActivity,
  SourceReference,
} from "../../src/domain.js";
import { conceptProposalText } from "./ui.js";
import {
  citation,
  citations,
  renderToolResult,
  toolResult,
} from "./presentation.js";

const sourceReferenceSchema = Type.Object({
  materialId: Type.String(),
  path: Type.String(),
  locator: Type.String(),
});
const questionSchema = Type.Object({
  id: Type.String(),
  kind: StringEnum(["primary", "transfer", "exam"] as const),
  targetConceptId: Type.String(),
  prompt: Type.String(),
  sourceRefs: Type.Array(sourceReferenceSchema, { minItems: 1 }),
});
const conceptProposalSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentId: Type.Optional(Type.String()),
  sourceRefs: Type.Array(sourceReferenceSchema, { minItems: 1 }),
});
const examGradeSchema = Type.Object({
  questionId: Type.String(),
  correctness: StringEnum([
    "correct",
    "partial",
    "incorrect",
    "ungradable",
  ] as const),
  gradingRationale: Type.String(),
  misconception: Type.Optional(Type.String()),
});
export interface ToolDependencies {
  app: TutorApplication;
  getActivity(): SessionActivity;
  persist(next: SessionActivity, ctx: ExtensionContext): void;
  showExamItem(ctx: ExtensionContext): void;
}

export function registerTools(
  pi: ExtensionAPI,
  dependencies: ToolDependencies,
): void {
  const { app, getActivity, persist, showExamItem } = dependencies;
  const questionTool = (
    name: "tutor_present_question" | "tutor_present_transfer",
    label: string,
  ) => {
    pi.registerTool({
      name,
      label,
      description: "Present one source-cited free-response tutor question.",
      parameters: Type.Object({ question: questionSchema }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _update, ctx) {
        const question = params.question as Question;
        const next = await app.recordQuestion(getActivity(), question);
        persist(next, ctx);
        return toolResult(
          `${question.prompt}\n\nSource: ${citations(question.sourceRefs)}`,
          `${label} presented.`,
        );
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", label), 0, 0);
      },
      renderResult: renderToolResult,
    });
  };

  questionTool("tutor_present_question", "Tutor question");
  questionTool("tutor_present_transfer", "Tutor transfer question");

  pi.registerTool({
    name: "tutor_present_exam",
    label: "Tutor exam",
    description: "Present the complete source-cited exam without feedback.",
    parameters: Type.Object({
      items: Type.Array(questionSchema, { minItems: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const current = getActivity();
      if (current.state.tag !== "exam-generating") {
        throw new Error("An exam is not currently being generated");
      }
      const exam: ExamSession = {
        id: `exam-${current.state.operationId}`,
        operationId: current.state.operationId,
        startedAt: current.state.startedAt,
        ...(current.state.deadlineAt === undefined
          ? {}
          : { deadlineAt: current.state.deadlineAt }),
        status: "active",
        items: params.items as Question[],
        drafts: {},
      };
      const next = await app.recordExam(current, exam);
      persist(next, ctx);
      showExamItem(ctx);
      return toolResult("Exam ready.", "Exam ready.");
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor exam"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_present_hint",
    label: "Tutor hint",
    description:
      "Present exactly the locally requested hint level with a source citation.",
    parameters: Type.Object({
      level: Type.Integer({ minimum: 1, maximum: 6 }),
      hint: Type.String(),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordHint(
        getActivity(),
        params.level as Exclude<HintLevel, 0>,
      );
      persist(next, ctx);
      return toolResult(
        `Hint ${params.level}: ${params.hint}\n\nSource: ${citation(params.sourceRef)}`,
        `Hint level ${params.level} presented.`,
      );
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Tutor hint ${args.level}`), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_record_grade",
    label: "Tutor feedback",
    description:
      "Record a source-cited canonical grade for the committed answer.",
    parameters: Type.Object({
      correctness: StringEnum([
        "correct",
        "partial",
        "incorrect",
        "ungradable",
      ] as const),
      gradingRationale: Type.String(),
      misconception: Type.Optional(Type.String()),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordGrade(getActivity(), {
        correctness: params.correctness,
        gradingRationale: params.gradingRationale,
        ...(params.misconception === undefined
          ? {}
          : { misconception: params.misconception }),
      });
      persist(next, ctx);
      const display = [
        `Result: ${params.correctness}`,
        params.gradingRationale,
        params.misconception === undefined
          ? undefined
          : `Misconception: ${params.misconception}`,
        `Source: ${citation(params.sourceRef)}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n");
      return toolResult(display, "Grade recorded.");
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor feedback"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_present_solution",
    label: "Tutor solution",
    description: "Present a requested solution with a source citation.",
    parameters: Type.Object({
      solution: Type.String(),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordSolution(getActivity());
      persist(next, ctx);
      return toolResult(
        `${params.solution}\n\nSource: ${citation(params.sourceRef)}\n\nNow explain the solution in your own words.`,
        "Solution presented; explanation required.",
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor solution"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_record_explanation",
    label: "Tutor explanation",
    description:
      "Record the learner's self-explanation before transfer practice.",
    parameters: Type.Object({ explanation: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const next = await app.recordExplanation(
        getActivity(),
        params.explanation,
      );
      persist(next, ctx);
      return toolResult(
        "Explanation recorded. Next, complete an unaided transfer question.",
        "Explanation recorded; transfer required.",
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor explanation"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_propose_concepts",
    label: "Tutor concept proposals",
    description: "Record source-cited concepts pending learner approval.",
    parameters: Type.Object({
      proposals: Type.Array(conceptProposalSchema, { minItems: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const courseId = requireCourseId(getActivity());
      const course = await app.proposeConcepts(
        courseId,
        params.proposals as CourseConceptProposal[],
      );
      return toolResult(
        conceptProposalText(course),
        `${course.proposedConcepts.length} concept proposal(s) pending learner approval.`,
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor concept proposals"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_record_exam_grades",
    label: "Tutor exam grades",
    description: "Record aggregate grades for a submitted exam only.",
    parameters: Type.Object({
      grades: Type.Array(examGradeSchema),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const submitted = getActivity();
      const next = await app.recordExamGrades(
        submitted,
        params.grades as ExamGrade[],
      );
      persist(next, ctx);
      const sourceByQuestionId =
        submitted.state.tag === "exam-submitted"
          ? new Map(
              submitted.state.exam.items.map(({ id, sourceRefs }) => [
                id,
                sourceRefs,
              ]),
            )
          : new Map<string, SourceReference[]>();
      const display = (params.grades as ExamGrade[])
        .map((grade) => {
          const sources = sourceByQuestionId.get(grade.questionId) ?? [];
          return [
            `${grade.questionId}: ${grade.correctness}`,
            grade.gradingRationale,
            ...(sources.length === 0 ? [] : [`Sources: ${citations(sources)}`]),
          ].join("\n");
        })
        .join("\n\n");
      return toolResult(display, "Aggregate exam grades recorded.");
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor exam grades"), 0, 0);
    },
    renderResult: renderToolResult,
  });
}

function requireCourseId(current: SessionActivity): string {
  if (current.state.courseId === undefined) {
    throw new Error("Select a course with /course before using tutor tools");
  }
  return current.state.courseId;
}

function assertCurrentCitation(
  state: ActivityState,
  sourceRef: SourceReference,
): void {
  const question = questionForState(state);
  if (
    question === undefined ||
    !question.sourceRefs.some(
      (configured) =>
        configured.materialId === sourceRef.materialId &&
        configured.path === sourceRef.path &&
        configured.locator === sourceRef.locator,
    )
  ) {
    throw new Error("Citation is not configured for the current question");
  }
}

function questionForState(state: ActivityState): Question | undefined {
  switch (state.tag) {
    case "awaiting-primary-answer":
    case "awaiting-grade":
    case "hint-requested":
    case "reveal-requested":
    case "awaiting-correction":
    case "awaiting-explanation":
      return state.question;
    default:
      return undefined;
  }
}

export function aggregateExamSubmission(current: SessionActivity): string {
  if (current.state.tag !== "exam-submitted") {
    throw new Error("Exam submission must be persisted before grading");
  }
  const { exam } = current.state;
  const submittedItems = exam.items.filter(({ id }) =>
    Object.hasOwn(exam.drafts, id),
  );
  return [
    "EXAM SUBMISSION — grade only after all answers below",
    ...submittedItems.map((question) => {
      const draft = exam.drafts[question.id]!;
      return [
        `Question ID: ${question.id}`,
        `Prompt: ${question.prompt}`,
        ...question.sourceRefs.map((source) => `Sources: ${citation(source)}`),
        `[confidence: ${draft.confidence}]`,
        draft.answer,
      ].join("\n");
    }),
    "Call tutor_record_exam_grades exactly once, covering every supplied Question ID. Do not provide learner feedback before that canonical tool call.",
  ].join("\n\n");
}
