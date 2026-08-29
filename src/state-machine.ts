import type {
  ActivityState,
  ExamSession,
  HintLevel,
  PartialAnswerPolicy,
  Question,
  TutorMode,
} from "./domain.js";

export type TutorEvent =
  | {
      type: "modeRequested";
      mode: TutorMode;
      operationId: string;
      startedAt: string;
      deadlineAt?: string;
    }
  | { type: "questionPresented"; question: Question }
  | { type: "submissionAccepted"; attemptId: string }
  | GradeRecordedEvent
  | { type: "hintRequested" }
  | { type: "hintPresented"; level: Exclude<HintLevel, 0> }
  | { type: "revealRequested" }
  | { type: "solutionPresented"; attemptId: string }
  | { type: "explanationAccepted"; attemptId: string; operationId: string }
  | { type: "transferRequested"; operationId: string }
  | { type: "examPresented"; exam: ExamSession }
  | {
      type: "examDraftAccepted";
      questionId: string;
      draft: ExamSession["drafts"][string];
    }
  | { type: "examSubmitted"; submittedAt: string; expired: boolean }
  | { type: "examGraded" };

export type GradeRecordedEvent =
  | {
      type: "gradeRecorded";
      correctness: "correct" | "ungradable";
      assisted: boolean;
      partialAnswerPolicy: PartialAnswerPolicy;
      nextOperationId: string;
    }
  | {
      type: "gradeRecorded";
      correctness: "partial";
      assisted: boolean;
      partialAnswerPolicy: "continue";
      nextOperationId: string;
    }
  | {
      type: "gradeRecorded";
      correctness: "partial";
      assisted: boolean;
      partialAnswerPolicy: "remediate";
    }
  | {
      type: "gradeRecorded";
      correctness: "incorrect";
      assisted: boolean;
      partialAnswerPolicy: PartialAnswerPolicy;
    };

/** Applies one protocol event without performing I/O or creating identifiers. */
export function transition(
  state: ActivityState,
  event: TutorEvent,
): ActivityState {
  switch (state.tag) {
    case "idle":
      if (event.type === "modeRequested") {
        if (state.courseId === undefined) {
          throw new Error("A course must be selected before starting a mode");
        }
        if (event.mode === "exam") {
          return {
            tag: "exam-generating",
            courseId: state.courseId,
            operationId: event.operationId,
            startedAt: event.startedAt,
            ...(event.deadlineAt === undefined
              ? {}
              : { deadlineAt: event.deadlineAt }),
          };
        }
        return {
          tag: "awaiting-question",
          courseId: state.courseId,
          mode: event.mode,
          operationId: event.operationId,
        };
      }
      return unsupported(state, event);

    case "awaiting-question":
      if (event.type === "questionPresented") {
        assertQuestionKind(event.question, "primary");
        return awaitingPrimaryAnswer(
          state.courseId,
          state.mode,
          event.question,
        );
      }
      return unsupported(state, event);

    case "awaiting-primary-answer":
      switch (event.type) {
        case "submissionAccepted":
          return {
            tag: "awaiting-grade",
            courseId: state.courseId,
            attemptId: event.attemptId,
            purpose:
              state.question.kind === "transfer" ? "transfer" : "primary",
            question: state.question,
            hintLevel: state.hintLevel,
            mode: state.mode,
          };
        case "hintRequested":
          if (state.question.kind === "transfer") {
            throw new Error("Hints are unavailable for a transfer question");
          }
          if (state.hintLevel === 6) {
            throw new Error("All hints have already been presented");
          }
          return {
            tag: "hint-requested",
            courseId: state.courseId,
            mode: state.mode,
            question: state.question,
            nextHintLevel: (state.hintLevel + 1) as Exclude<HintLevel, 0>,
            revealed: state.revealed,
          };
        case "revealRequested":
          if (state.question.kind === "transfer") {
            throw new Error("Reveal is unavailable for a transfer question");
          }
          return {
            tag: "reveal-requested",
            courseId: state.courseId,
            mode: state.mode,
            question: state.question,
            hintLevel: state.hintLevel,
          };
        default:
          return unsupported(state, event);
      }

    case "awaiting-grade":
      if (event.type === "gradeRecorded") {
        return transitionGrade(state, event);
      }
      return unsupported(state, event);

    case "hint-requested":
      if (event.type === "hintPresented") {
        if (event.level !== state.nextHintLevel) {
          throw new Error(`Expected hint level ${state.nextHintLevel}`);
        }
        return awaitingPrimaryAnswer(
          state.courseId,
          state.mode,
          state.question,
          event.level,
          state.revealed,
        );
      }
      return unsupported(state, event);

    case "reveal-requested":
      if (event.type === "solutionPresented") {
        return {
          tag: "awaiting-explanation",
          courseId: state.courseId,
          mode: state.mode,
          attemptId: event.attemptId,
          question: state.question,
          reason: "reveal",
        };
      }
      return unsupported(state, event);

    case "awaiting-correction":
      if (event.type === "submissionAccepted") {
        return {
          tag: "awaiting-explanation",
          courseId: state.courseId,
          mode: state.mode,
          attemptId: event.attemptId,
          question: state.question,
          reason: "error",
        };
      }
      return unsupported(state, event);

    case "awaiting-explanation":
      if (event.type === "explanationAccepted") {
        return {
          tag: "awaiting-transfer",
          courseId: state.courseId,
          mode: state.mode,
          parentAttemptId: event.attemptId,
          operationId: event.operationId,
        };
      }
      return unsupported(state, event);

    case "awaiting-transfer":
      if (event.type === "questionPresented") {
        assertQuestionKind(event.question, "transfer");
        return awaitingPrimaryAnswer(
          state.courseId,
          state.mode,
          event.question,
        );
      }
      return unsupported(state, event);

    case "exam-generating":
      if (event.type === "examPresented") {
        return {
          tag: "exam-active",
          courseId: state.courseId,
          exam: event.exam,
        };
      }
      return unsupported(state, event);

    case "exam-active":
      if (event.type === "hintRequested") {
        throw new Error("Hints are unavailable during an exam");
      }
      if (event.type === "revealRequested") {
        throw new Error("Reveal is unavailable during an exam");
      }
      if (event.type === "examDraftAccepted") {
        if (!state.exam.items.some(({ id }) => id === event.questionId)) {
          throw new Error(`Unknown exam question: ${event.questionId}`);
        }
        return {
          tag: "exam-active",
          courseId: state.courseId,
          exam: {
            ...state.exam,
            drafts: { ...state.exam.drafts, [event.questionId]: event.draft },
          },
        };
      }
      if (event.type === "examSubmitted") {
        return {
          tag: "exam-submitted",
          courseId: state.courseId,
          exam: {
            ...state.exam,
            submittedAt: event.submittedAt,
            status: event.expired ? "expired" : "submitted",
          },
        };
      }
      return unsupported(state, event);

    case "exam-submitted":
      if (event.type === "examGraded" && state.exam.status !== "graded") {
        return {
          tag: "exam-submitted",
          courseId: state.courseId,
          exam: { ...state.exam, status: "graded" },
        };
      }
      return unsupported(state, event);

    default:
      return assertNever(state);
  }
}

function transitionGrade(
  state: Extract<ActivityState, { tag: "awaiting-grade" }>,
  event: GradeRecordedEvent,
): ActivityState {
  if (
    event.correctness === "correct" ||
    event.correctness === "ungradable" ||
    (event.correctness === "partial" &&
      event.partialAnswerPolicy === "continue")
  ) {
    if (!("nextOperationId" in event)) {
      throw new Error("A next operation ID is required after this grade");
    }
    return {
      tag: "awaiting-question",
      courseId: state.courseId,
      mode: state.mode,
      operationId: event.nextOperationId,
    };
  }

  return {
    tag: "awaiting-correction",
    courseId: state.courseId,
    mode: state.mode,
    attemptId: state.attemptId,
    question: state.question,
    hintLevel: state.hintLevel,
  };
}

function awaitingPrimaryAnswer(
  courseId: string,
  mode: Exclude<TutorMode, "exam">,
  question: Question,
  hintLevel: HintLevel = 0,
  revealed = false,
): ActivityState {
  return {
    tag: "awaiting-primary-answer",
    courseId,
    mode,
    question,
    hintLevel,
    revealed,
  };
}

function assertQuestionKind(
  question: Question,
  expectedKind: "primary" | "transfer",
): void {
  if (question.kind !== expectedKind) {
    throw new Error(`Expected a ${expectedKind} question`);
  }
}

function unsupported(state: ActivityState, event: TutorEvent): never {
  throw new Error(`Unsupported transition: ${state.tag} + ${event.type}`);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected activity state: ${JSON.stringify(value)}`);
}
