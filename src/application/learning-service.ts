import {
  assertQuestion,
  isAnsweredAttempt,
  type ActivityState,
  type Correctness,
  type Course,
  type HintLevel,
  type ModeOptions,
  type Question,
  type SessionActivity,
  type Submission,
  type TutorMode,
} from "../domain.js";
import { trackForAttempt } from "../scheduler.js";
import { transition } from "../state-machine.js";
import { ApplicationRuntime } from "./runtime.js";

export interface Grade {
  correctness: Correctness;
  gradingRationale: string;
  misconception?: string;
}

export type RegularSubmission = Omit<Submission, "confidence"> & {
  confidence?: number;
};

export class LearningService {
  constructor(private readonly runtime: ApplicationRuntime) {}

  async requestMode(
    courseId: string,
    mode: Exclude<TutorMode, "exam">,
    options: ModeOptions = {},
  ): Promise<SessionActivity> {
    await this.runtime.store.getCourse(courseId);
    return this.runtime.activity(
      transition(
        { tag: "idle", courseId },
        {
          type: "modeRequested",
          mode,
          operationId: this.runtime.operationId(),
          startedAt: this.runtime.clock.now().toISOString(),
          ...(options.deadlineAt === undefined
            ? {}
            : { deadlineAt: options.deadlineAt }),
        },
      ),
    );
  }

  async recordQuestion(
    current: SessionActivity,
    question: Question,
  ): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
    assertQuestion(course, question);
    return this.runtime.activity(
      transition(current.state, { type: "questionPresented", question }),
    );
  }

  async acceptSubmission(
    current: SessionActivity,
    submission: RegularSubmission,
  ): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
    const details = submissionDetails(current.state);
    assertSubmission(submission, details.requiresConfidence);
    assertQuestion(course, details.question);

    const attemptId = this.runtime.ids.next("attempt");
    const operationId = this.runtime.operationId();
    const next = transition(current.state, {
      type: "submissionAccepted",
      attemptId,
    });
    const history = await this.runtime.store.getHistory(course.id);
    const original = history.attempts.find(
      (attempt) =>
        attempt.question.id === details.question.id &&
        attempt.mode === details.mode &&
        attempt.highestHintLevel === details.hintLevel &&
        attempt.revealed === details.revealed,
    );
    const submittedAt = this.runtime.clock.now().toISOString();

    await this.runtime.store.commitHistory(
      course.id,
      history.revision,
      operationId,
      (currentHistory) => ({
        ...currentHistory,
        revision: currentHistory.revision + 1,
        attempts: [
          ...currentHistory.attempts,
          {
            id: attemptId,
            operationId,
            kind: "answered" as const,
            ...(original === undefined
              ? {}
              : { retryOfAttemptId: original.id }),
            question: details.question,
            mode: details.mode,
            submittedAt,
            answer: submission.answer,
            confidence: submission.confidence,
            unaidedAtSubmission: details.hintLevel === 0 && !details.revealed,
            highestHintLevel: details.hintLevel,
            revealed: details.revealed,
          },
        ],
      }),
    );
    return this.runtime.activity(next);
  }

  async requestHint(current: SessionActivity): Promise<SessionActivity> {
    await this.runtime.courseFor(current);
    return this.runtime.activity(
      transition(current.state, { type: "hintRequested" }),
    );
  }

  async recordHint(
    current: SessionActivity,
    level: Exclude<HintLevel, 0>,
  ): Promise<SessionActivity> {
    await this.runtime.courseFor(current);
    return this.runtime.activity(
      transition(current.state, { type: "hintPresented", level }),
    );
  }

  async requestReveal(current: SessionActivity): Promise<SessionActivity> {
    await this.runtime.courseFor(current);
    return this.runtime.activity(
      transition(current.state, { type: "revealRequested" }),
    );
  }

  async recordSolution(current: SessionActivity): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
    if (current.state.tag !== "reveal-requested") {
      throw new Error("A solution is not currently requested");
    }
    const state = current.state;
    assertQuestion(course, state.question);

    const attemptId = this.runtime.ids.next("attempt");
    const operationId = this.runtime.operationId();
    const next = transition(state, {
      type: "solutionPresented",
      attemptId,
    });
    const history = await this.runtime.store.getHistory(course.id);
    const submittedAt = this.runtime.clock.now().toISOString();

    await this.runtime.store.commitHistory(
      course.id,
      history.revision,
      operationId,
      (currentHistory) => ({
        ...currentHistory,
        revision: currentHistory.revision + 1,
        attempts: [
          ...currentHistory.attempts,
          {
            id: attemptId,
            operationId,
            kind: "answered" as const,
            question: state.question,
            mode: state.mode,
            submittedAt,
            answer: "",
            confidence: 0,
            unaidedAtSubmission: false,
            highestHintLevel: state.hintLevel,
            revealed: true,
          },
        ],
      }),
    );
    return this.runtime.activity(next);
  }

  async recordGrade(
    current: SessionActivity,
    grade: Grade,
  ): Promise<SessionActivity> {
    assertGrade(grade);
    const state = current.state;
    if (state.tag !== "awaiting-grade") {
      throw new Error("A grade can only be recorded after a submission");
    }
    const course = await this.runtime.courseFor(current);
    assertQuestion(course, state.question);

    const history = await this.runtime.store.getHistory(course.id);
    const attemptIndex = history.attempts.findIndex(
      ({ id }) => id === state.attemptId,
    );
    if (attemptIndex === -1) {
      throw new Error(`Attempt does not exist: ${state.attemptId}`);
    }
    const original = history.attempts[attemptIndex]!;
    if (!isAnsweredAttempt(original)) {
      throw new Error(`Attempt cannot be graded: ${original.id}`);
    }
    if (original.correctness !== undefined) {
      throw new Error(`Attempt is already graded: ${original.id}`);
    }
    const reviewedAt = this.runtime.clock.now();
    const reviewed = {
      ...original,
      correctness: grade.correctness,
      gradingRationale: grade.gradingRationale,
      ...(grade.misconception === undefined
        ? {}
        : { misconception: grade.misconception }),
    };
    const trackName = trackForAttempt(reviewed);
    const nextOperationId = this.runtime.operationId();
    const assisted = trackName === "assisted";
    const next = transitionForGrade(
      state,
      grade.correctness,
      assisted,
      course.partialAnswerPolicy,
      nextOperationId,
    );

    await this.runtime.store.commitHistory(
      course.id,
      history.revision,
      this.runtime.operationId(),
      (currentHistory) => {
        const attempt = currentHistory.attempts.find(
          ({ id }) => id === original.id,
        );
        if (
          attempt === undefined ||
          !isAnsweredAttempt(attempt) ||
          attempt.correctness !== undefined
        ) {
          throw new Error(`Attempt is already graded: ${original.id}`);
        }
        const updatedAttempt = {
          ...reviewed,
          operationId: attempt.operationId,
        };
        const progress = currentHistory.concepts[
          updatedAttempt.question.targetConceptId
        ] ?? {
          misconceptions: [],
        };
        const updatedTrack =
          trackName === undefined
            ? undefined
            : this.runtime.scheduler.apply(
                progress[trackName],
                grade.correctness,
                reviewedAt,
              );
        return {
          ...currentHistory,
          revision: currentHistory.revision + 1,
          attempts: currentHistory.attempts.map((entry) =>
            entry.id === updatedAttempt.id ? updatedAttempt : entry,
          ),
          concepts: {
            ...currentHistory.concepts,
            [updatedAttempt.question.targetConceptId]: {
              ...progress,
              ...(trackName === undefined || updatedTrack === undefined
                ? {}
                : { [trackName]: updatedTrack }),
              misconceptions:
                grade.misconception === undefined
                  ? progress.misconceptions
                  : [
                      ...progress.misconceptions,
                      {
                        text: grade.misconception,
                        sourceRef: updatedAttempt.question.sourceRefs[0],
                        lastSeenAt: reviewedAt.toISOString(),
                      },
                    ],
            },
          },
        };
      },
    );
    return this.runtime.activity(next);
  }

  async recordExplanation(
    current: SessionActivity,
    explanation: string,
  ): Promise<SessionActivity> {
    if (typeof explanation !== "string" || explanation.trim() === "") {
      throw new Error("Explanation must not be empty");
    }
    const course = await this.runtime.courseFor(current);
    if (current.state.tag !== "awaiting-explanation") {
      throw new Error("An explanation is not currently requested");
    }
    const attemptId = current.state.attemptId;
    const operationId = this.runtime.operationId();
    const next = transition(current.state, {
      type: "explanationAccepted",
      attemptId,
      operationId: this.runtime.operationId(),
    });
    const history = await this.runtime.store.getHistory(course.id);
    if (!history.attempts.some((attempt) => attempt.id === attemptId)) {
      throw new Error(`Attempt does not exist: ${attemptId}`);
    }
    await this.runtime.store.commitHistory(
      course.id,
      history.revision,
      operationId,
      (currentHistory) => ({
        ...currentHistory,
        revision: currentHistory.revision + 1,
        attempts: currentHistory.attempts.map((attempt) =>
          attempt.id === attemptId
            ? { ...attempt, selfExplanation: explanation }
            : attempt,
        ),
      }),
    );
    return this.runtime.activity(next);
  }
}

function submissionDetails(state: ActivityState): {
  question: Question;
  mode: Exclude<TutorMode, "exam">;
  hintLevel: HintLevel;
  revealed: boolean;
  requiresConfidence: boolean;
} {
  if (state.tag === "awaiting-primary-answer") {
    return {
      question: state.question,
      mode: state.mode,
      hintLevel: state.hintLevel,
      revealed: state.revealed,
      requiresConfidence: true,
    };
  }
  if (state.tag === "awaiting-correction") {
    return {
      question: state.question,
      mode: state.mode,
      hintLevel: state.hintLevel,
      revealed: false,
      requiresConfidence: false,
    };
  }
  throw new Error("A submission is not currently requested");
}

function transitionForGrade(
  state: Extract<ActivityState, { tag: "awaiting-grade" }>,
  correctness: Correctness,
  assisted: boolean,
  partialAnswerPolicy: Course["partialAnswerPolicy"],
  nextOperationId: string,
): ActivityState {
  if (correctness === "incorrect") {
    return transition(state, {
      type: "gradeRecorded",
      correctness,
      assisted,
      partialAnswerPolicy,
    });
  }
  if (correctness === "partial" && partialAnswerPolicy === "remediate") {
    return transition(state, {
      type: "gradeRecorded",
      correctness,
      assisted,
      partialAnswerPolicy,
    });
  }
  if (correctness === "partial") {
    return transition(state, {
      type: "gradeRecorded",
      correctness,
      assisted,
      partialAnswerPolicy: "continue",
      nextOperationId,
    });
  }
  return transition(state, {
    type: "gradeRecorded",
    correctness,
    assisted,
    partialAnswerPolicy,
    nextOperationId,
  });
}

function assertSubmission(
  submission: RegularSubmission,
  requiresConfidence: boolean,
): void {
  if (
    typeof submission.answer !== "string" ||
    submission.answer.trim() === ""
  ) {
    throw new Error("Answer must not be empty");
  }
  if (submission.confidence === undefined) {
    if (requiresConfidence) {
      throw new Error("Confidence must be between 0 and 100");
    }
    return;
  }
  if (
    typeof submission.confidence !== "number" ||
    !Number.isFinite(submission.confidence) ||
    submission.confidence < 0 ||
    submission.confidence > 100
  ) {
    throw new Error("Confidence must be between 0 and 100");
  }
}

function assertGrade(grade: Grade): void {
  if (
    grade.correctness !== "correct" &&
    grade.correctness !== "partial" &&
    grade.correctness !== "incorrect" &&
    grade.correctness !== "ungradable"
  ) {
    throw new Error("Invalid correctness");
  }
  if (typeof grade.gradingRationale !== "string") {
    throw new Error("Grading rationale must be a string");
  }
  if (
    grade.misconception !== undefined &&
    typeof grade.misconception !== "string"
  ) {
    throw new Error("Misconception must be a string");
  }
}
