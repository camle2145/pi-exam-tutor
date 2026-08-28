import { isAbsolute, normalize } from "node:path";
import type { Clock, IdGenerator } from "./clock.js";
import {
  assertCourseInvariant,
  assertQuestion,
  type ActivityState,
  type Correctness,
  type Course,
  type ExamSession,
  type HintLevel,
  type ModeOptions,
  type Question,
  type SessionActivity,
  type Submission,
  type TutorMode,
} from "./domain.js";
import {
  scheduler as defaultScheduler,
  trackForAttempt,
  type Scheduler,
} from "./scheduler.js";
import type { Store } from "./storage.js";
import { transition } from "./state-machine.js";

export interface Grade {
  correctness: Correctness;
  gradingRationale: string;
  misconception?: string;
}

/** Application boundary for durable learning evidence and pure protocol transitions. */
export interface TutorApplication {
  createCourse(name: string): Promise<Course>;
  selectCourse(
    courseId: string,
    session: SessionActivity,
  ): Promise<SessionActivity>;
  addMaterial(courseId: string, absolutePath: string): Promise<Course>;
  requestMode(
    courseId: string,
    mode: TutorMode,
    options?: ModeOptions,
  ): Promise<SessionActivity>;
  recordQuestion(
    activity: SessionActivity,
    question: Question,
  ): Promise<SessionActivity>;
  acceptSubmission(
    activity: SessionActivity,
    submission: Submission,
  ): Promise<SessionActivity>;
  requestHint(activity: SessionActivity): Promise<SessionActivity>;
  recordHint(
    activity: SessionActivity,
    level: Exclude<HintLevel, 0>,
  ): Promise<SessionActivity>;
  requestReveal(activity: SessionActivity): Promise<SessionActivity>;
  recordGrade(
    activity: SessionActivity,
    grade: Grade,
  ): Promise<SessionActivity>;
  recordExplanation(
    activity: SessionActivity,
    explanation: string,
  ): Promise<SessionActivity>;
  recordExam(
    activity: SessionActivity,
    exam: ExamSession,
  ): Promise<SessionActivity>;
  submitExam(activity: SessionActivity): Promise<SessionActivity>;
  serializeActivity(activity: SessionActivity): string;
  restoreActivity(snapshot: string): SessionActivity;
}

export class TutorApplicationService implements TutorApplication {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scheduler: Scheduler = defaultScheduler,
  ) {}

  async createCourse(name: string): Promise<Course> {
    return this.store.createCourse(name, this.operationId());
  }

  async selectCourse(
    courseId: string,
    session: SessionActivity,
  ): Promise<SessionActivity> {
    assertActivity(session);
    await this.store.getCourse(courseId);
    return activity({ tag: "idle", courseId });
  }

  async addMaterial(courseId: string, absolutePath: string): Promise<Course> {
    if (!isAbsolute(absolutePath) || normalize(absolutePath) !== absolutePath) {
      throw new Error("Material path must be absolute and normalized");
    }

    const course = await this.store.getCourse(courseId);
    if (course.materials.some(({ path }) => path === absolutePath)) {
      throw new Error(`Material path is already configured: ${absolutePath}`);
    }
    const next: Course = {
      ...course,
      revision: course.revision + 1,
      materials: [
        ...course.materials,
        {
          id: this.ids.next("material"),
          path: absolutePath,
          addedAt: this.clock.now().toISOString(),
        },
      ],
    };
    assertCourseInvariant(next);
    return this.store.saveCourse(next, course.revision, this.operationId());
  }

  async requestMode(
    courseId: string,
    mode: TutorMode,
    options: ModeOptions = {},
  ): Promise<SessionActivity> {
    await this.store.getCourse(courseId);
    return activity(
      transition(
        { tag: "idle", courseId },
        {
          type: "modeRequested",
          mode,
          operationId: this.operationId(),
          startedAt: this.clock.now().toISOString(),
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
    const course = await this.courseFor(current);
    assertQuestion(course, question);
    return activity(
      transition(current.state, { type: "questionPresented", question }),
    );
  }

  async acceptSubmission(
    current: SessionActivity,
    submission: Submission,
  ): Promise<SessionActivity> {
    assertSubmission(submission);
    const course = await this.courseFor(current);
    const details = submissionDetails(current.state);
    assertQuestion(course, details.question);

    const attemptId = this.ids.next("attempt");
    const operationId = this.operationId();
    const next = transition(current.state, {
      type: "submissionAccepted",
      attemptId,
    });
    const history = await this.store.getHistory(course.id);
    const original = history.attempts.find(
      (attempt) =>
        attempt.question.id === details.question.id &&
        attempt.mode === details.mode &&
        attempt.correctness === undefined &&
        attempt.highestHintLevel === details.hintLevel &&
        attempt.revealed === details.revealed,
    );
    const submittedAt = this.clock.now().toISOString();

    await this.store.commitHistory(
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
    return activity(next);
  }

  async requestHint(current: SessionActivity): Promise<SessionActivity> {
    await this.courseFor(current);
    return activity(transition(current.state, { type: "hintRequested" }));
  }

  async recordHint(
    current: SessionActivity,
    level: Exclude<HintLevel, 0>,
  ): Promise<SessionActivity> {
    await this.courseFor(current);
    return activity(
      transition(current.state, { type: "hintPresented", level }),
    );
  }

  async requestReveal(current: SessionActivity): Promise<SessionActivity> {
    await this.courseFor(current);
    return activity(transition(current.state, { type: "revealRequested" }));
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
    const course = await this.courseFor(current);
    assertQuestion(course, state.question);

    const history = await this.store.getHistory(course.id);
    const attemptIndex = history.attempts.findIndex(
      ({ id }) => id === state.attemptId,
    );
    if (attemptIndex === -1) {
      throw new Error(`Attempt does not exist: ${state.attemptId}`);
    }
    const original = history.attempts[attemptIndex]!;
    if (original.correctness !== undefined) {
      throw new Error(`Attempt is already graded: ${original.id}`);
    }
    const reviewedAt = this.clock.now();
    const reviewed = {
      ...original,
      correctness: grade.correctness,
      gradingRationale: grade.gradingRationale,
      ...(grade.misconception === undefined
        ? {}
        : { misconception: grade.misconception }),
    };
    const trackName = trackForAttempt(reviewed);
    const nextOperationId = this.operationId();
    const assisted = trackName === "assisted";
    const next = transitionForGrade(
      state,
      grade.correctness,
      assisted,
      course.partialAnswerPolicy,
      nextOperationId,
    );

    await this.store.commitHistory(
      course.id,
      history.revision,
      this.operationId(),
      (currentHistory) => {
        const attempt = currentHistory.attempts.find(
          ({ id }) => id === original.id,
        );
        if (attempt === undefined || attempt.correctness !== undefined) {
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
            : this.scheduler.apply(
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
    return activity(next);
  }

  async recordExplanation(
    current: SessionActivity,
    explanation: string,
  ): Promise<SessionActivity> {
    if (typeof explanation !== "string" || explanation.trim() === "") {
      throw new Error("Explanation must not be empty");
    }
    const course = await this.courseFor(current);
    if (current.state.tag !== "awaiting-explanation") {
      throw new Error("An explanation is not currently requested");
    }
    const attemptId = current.state.attemptId;
    const operationId = this.operationId();
    const next = transition(current.state, {
      type: "explanationAccepted",
      attemptId,
      operationId: this.operationId(),
    });
    const history = await this.store.getHistory(course.id);
    if (!history.attempts.some((attempt) => attempt.id === attemptId)) {
      throw new Error(`Attempt does not exist: ${attemptId}`);
    }
    await this.store.commitHistory(
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
    return activity(next);
  }

  async recordExam(
    current: SessionActivity,
    exam: ExamSession,
  ): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    for (const question of exam.items) {
      assertQuestion(course, question);
      if (question.kind !== "exam") {
        throw new Error("Exam items must be exam questions");
      }
    }
    return activity(transition(current.state, { type: "examPresented", exam }));
  }

  async submitExam(current: SessionActivity): Promise<SessionActivity> {
    await this.courseFor(current);
    const now = this.clock.now();
    const deadline =
      current.state.tag === "exam-active"
        ? current.state.exam.deadlineAt
        : undefined;
    return activity(
      transition(current.state, {
        type: "examSubmitted",
        submittedAt: now.toISOString(),
        expired: deadline !== undefined && now > new Date(deadline),
      }),
    );
  }

  serializeActivity(current: SessionActivity): string {
    assertActivity(current);
    return JSON.stringify(current);
  }

  restoreActivity(snapshot: string): SessionActivity {
    let decoded: unknown;
    try {
      decoded = JSON.parse(snapshot) as unknown;
    } catch {
      throw new Error("Invalid activity snapshot");
    }
    assertActivity(decoded);
    return JSON.parse(JSON.stringify(decoded)) as SessionActivity;
  }

  private async courseFor(current: SessionActivity): Promise<Course> {
    assertActivity(current);
    const courseId = current.state.courseId;
    if (courseId === undefined) {
      throw new Error("An activity must select a course");
    }
    return this.store.getCourse(courseId);
  }

  private operationId(): string {
    return this.ids.next("operation");
  }
}

function activity(state: ActivityState): SessionActivity {
  return { schemaVersion: 1, state };
}

function submissionDetails(state: ActivityState): {
  question: Question;
  mode: Exclude<TutorMode, "exam">;
  hintLevel: HintLevel;
  revealed: boolean;
} {
  if (state.tag === "awaiting-primary-answer") {
    return {
      question: state.question,
      mode: state.mode,
      hintLevel: state.hintLevel,
      revealed: state.revealed,
    };
  }
  if (state.tag === "awaiting-correction") {
    return {
      question: state.question,
      mode: state.mode,
      hintLevel: state.hintLevel,
      revealed: false,
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

function assertSubmission(submission: Submission): void {
  if (
    typeof submission.answer !== "string" ||
    submission.answer.trim() === ""
  ) {
    throw new Error("Answer must not be empty");
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

function assertActivity(value: unknown): asserts value is SessionActivity {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "schemaVersion") ||
    !Object.hasOwn(value, "state") ||
    (value as { schemaVersion: unknown }).schemaVersion !== 1 ||
    typeof (value as { state: unknown }).state !== "object" ||
    (value as { state: unknown }).state === null
  ) {
    throw new Error("Invalid activity snapshot");
  }
}
