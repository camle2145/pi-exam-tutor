import { ActivityCodec } from "./application/activity-codec.js";
import { CourseService } from "./application/course-service.js";
import {
  LearningService,
  type Grade,
  type RegularSubmission,
} from "./application/learning-service.js";
import { ApplicationRuntime } from "./application/runtime.js";
import type { Clock, IdGenerator } from "./clock.js";
import {
  assertQuestion,
  isGrammarSafeExamQuestionId,
  type ActivityState,
  type Correctness,
  type Course,
  type CourseConceptProposal,
  type ExamGrade,
  type ExamSession,
  type HintLevel,
  type ModeOptions,
  type Question,
  type SessionActivity,
  type TutorMode,
} from "./domain.js";
import {
  scheduler as defaultScheduler,
  trackForAttempt,
  type Scheduler,
} from "./scheduler.js";
import type { Store } from "./storage.js";
import { transition } from "./state-machine.js";

export type { Grade } from "./application/learning-service.js";

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
    submission: RegularSubmission,
  ): Promise<SessionActivity>;
  requestHint(activity: SessionActivity): Promise<SessionActivity>;
  recordHint(
    activity: SessionActivity,
    level: Exclude<HintLevel, 0>,
  ): Promise<SessionActivity>;
  requestReveal(activity: SessionActivity): Promise<SessionActivity>;
  recordSolution(activity: SessionActivity): Promise<SessionActivity>;
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
  proposeConcepts(
    courseId: string,
    proposals: readonly import("./domain.js").CourseConceptProposal[],
  ): Promise<Course>;
  approveConcepts(
    courseId: string,
    conceptIds: readonly string[],
  ): Promise<Course>;
  editProposedConcept(
    courseId: string,
    conceptId: string,
    update: { name?: string; parentId?: string | null },
  ): Promise<Course>;
  removeProposedConcept(courseId: string, conceptId: string): Promise<Course>;
  recordExamGrades(
    activity: SessionActivity,
    grades: readonly import("./domain.js").ExamGrade[],
  ): Promise<SessionActivity>;
  serializeActivity(activity: SessionActivity): string;
  restoreActivity(snapshot: string): SessionActivity;
}

export class TutorApplicationService implements TutorApplication {
  private readonly codec: ActivityCodec = new ActivityCodec();
  private readonly runtime: ApplicationRuntime;
  private readonly courses: CourseService;
  private readonly learning: LearningService;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scheduler: Scheduler = defaultScheduler,
  ) {
    this.runtime = new ApplicationRuntime(
      store,
      clock,
      ids,
      scheduler,
      this.codec,
    );
    this.courses = new CourseService(this.runtime);
    this.learning = new LearningService(this.runtime);
  }

  async createCourse(name: string): Promise<Course> {
    return this.courses.createCourse(name);
  }

  async selectCourse(
    courseId: string,
    session: SessionActivity,
  ): Promise<SessionActivity> {
    return this.courses.selectCourse(courseId, session);
  }

  async addMaterial(courseId: string, absolutePath: string): Promise<Course> {
    return this.courses.addMaterial(courseId, absolutePath);
  }

  async requestMode(
    courseId: string,
    mode: TutorMode,
    options: ModeOptions = {},
  ): Promise<SessionActivity> {
    return mode === "exam"
      ? this.requestExamMode(courseId, options)
      : this.learning.requestMode(courseId, mode, options);
  }

  private async requestExamMode(
    courseId: string,
    options: ModeOptions,
  ): Promise<SessionActivity> {
    await this.runtime.store.getCourse(courseId);
    return this.runtime.activity(
      transition(
        { tag: "idle", courseId },
        {
          type: "modeRequested",
          mode: "exam",
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
    activity: SessionActivity,
    question: Question,
  ): Promise<SessionActivity> {
    return this.learning.recordQuestion(activity, question);
  }

  async acceptSubmission(
    activity: SessionActivity,
    submission: RegularSubmission,
  ): Promise<SessionActivity> {
    return this.learning.acceptSubmission(activity, submission);
  }

  async requestHint(activity: SessionActivity): Promise<SessionActivity> {
    return this.learning.requestHint(activity);
  }

  async recordHint(
    activity: SessionActivity,
    level: Exclude<HintLevel, 0>,
  ): Promise<SessionActivity> {
    return this.learning.recordHint(activity, level);
  }

  async requestReveal(activity: SessionActivity): Promise<SessionActivity> {
    return this.learning.requestReveal(activity);
  }

  async recordSolution(activity: SessionActivity): Promise<SessionActivity> {
    return this.learning.recordSolution(activity);
  }

  async recordGrade(
    activity: SessionActivity,
    grade: Grade,
  ): Promise<SessionActivity> {
    return this.learning.recordGrade(activity, grade);
  }

  async recordExplanation(
    activity: SessionActivity,
    explanation: string,
  ): Promise<SessionActivity> {
    return this.learning.recordExplanation(activity, explanation);
  }

  async recordExam(
    current: SessionActivity,
    exam: ExamSession,
  ): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    if (exam.items.length === 0) {
      throw new Error("Exam must contain at least one question");
    }
    const itemIds = new Set<string>();
    for (const question of exam.items) {
      if (!isGrammarSafeExamQuestionId(question.id)) {
        throw new Error(
          `Exam question ID is not safe for draft syntax: ${question.id}`,
        );
      }
      if (itemIds.has(question.id)) {
        throw new Error(`Duplicate exam question id: ${question.id}`);
      }
      itemIds.add(question.id);
      assertQuestion(course, question);
      if (question.kind !== "exam") {
        throw new Error("Exam items must be exam questions");
      }
    }
    return activity(transition(current.state, { type: "examPresented", exam }));
  }

  async submitExam(current: SessionActivity): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    if (current.state.tag !== "exam-active") {
      throw new Error("An exam can only be submitted while active");
    }

    const exam = current.state.exam;
    for (const question of exam.items) {
      assertQuestion(course, question);
    }
    const now = this.clock.now();
    const submittedAt = now.toISOString();
    const expired =
      exam.deadlineAt !== undefined && now > new Date(exam.deadlineAt);
    const omissions = exam.items.filter(
      ({ id }) => exam.drafts[id] === undefined,
    );

    if (omissions.length > 0) {
      const history = await this.store.getHistory(course.id);
      const operationId = this.operationId();
      const attempts = omissions.map((question) => ({
        id: this.ids.next("attempt"),
        operationId,
        kind: "unanswered" as const,
        question,
        mode: "exam" as const,
        submittedAt,
        unaidedAtSubmission: true,
        highestHintLevel: 0 as const,
        revealed: false,
        omissionReason: expired
          ? ("deadline" as const)
          : ("manual-partial" as const),
      }));

      await this.store.commitHistory(
        course.id,
        history.revision,
        operationId,
        (currentHistory) => {
          let concepts = currentHistory.concepts;
          const scheduledConceptIds = new Set<string>();
          for (const attempt of attempts) {
            if (scheduledConceptIds.has(attempt.question.targetConceptId)) {
              continue;
            }
            scheduledConceptIds.add(attempt.question.targetConceptId);
            const conceptId = attempt.question.targetConceptId;
            const progress = concepts[conceptId] ?? { misconceptions: [] };
            const unassisted = this.scheduler.apply(
              progress.unassisted,
              "incorrect",
              now,
            );
            concepts = {
              ...concepts,
              [conceptId]: {
                ...progress,
                ...(unassisted === undefined ? {} : { unassisted }),
              },
            };
          }
          return {
            ...currentHistory,
            revision: currentHistory.revision + 1,
            attempts: [...currentHistory.attempts, ...attempts],
            concepts,
          };
        },
      );
    }

    return activity(
      transition(current.state, {
        type: "examSubmitted",
        submittedAt,
        expired,
      }),
    );
  }

  async proposeConcepts(
    courseId: string,
    proposals: readonly CourseConceptProposal[],
  ): Promise<Course> {
    return this.courses.proposeConcepts(courseId, proposals);
  }

  async approveConcepts(
    courseId: string,
    conceptIds: readonly string[],
  ): Promise<Course> {
    return this.courses.approveConcepts(courseId, conceptIds);
  }

  async editProposedConcept(
    courseId: string,
    conceptId: string,
    update: { name?: string; parentId?: string | null },
  ): Promise<Course> {
    return this.courses.editProposedConcept(courseId, conceptId, update);
  }

  async removeProposedConcept(
    courseId: string,
    conceptId: string,
  ): Promise<Course> {
    return this.courses.removeProposedConcept(courseId, conceptId);
  }

  async recordExamGrades(
    current: SessionActivity,
    grades: readonly ExamGrade[],
  ): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    if (current.state.tag !== "exam-submitted") {
      throw new Error("Exam grades can only be recorded after submission");
    }
    const exam = current.state.exam;
    if (exam.status === "graded") {
      throw new Error("Exam has already been graded");
    }
    if (
      (exam.status !== "submitted" && exam.status !== "expired") ||
      exam.submittedAt === undefined
    ) {
      throw new Error("Exam grades can only be recorded after submission");
    }

    const draftIds = new Set(Object.keys(exam.drafts));
    if (grades.length !== draftIds.size) {
      throw new Error("Exam grades must exactly cover submitted drafts");
    }

    const questionsById = new Map(
      exam.items.map((question) => [question.id, question]),
    );
    const submittedQuestions = new Map<string, Question>();
    const gradedIds = new Set<string>();
    for (const grade of grades) {
      if (!draftIds.has(grade.questionId)) {
        throw new Error(
          `Grade references unknown exam question: ${grade.questionId}`,
        );
      }
      if (gradedIds.has(grade.questionId)) {
        throw new Error(`Duplicate grade for question: ${grade.questionId}`);
      }
      const question = questionsById.get(grade.questionId);
      if (question === undefined) {
        throw new Error(
          `Grade references an exam item that was not submitted: ${grade.questionId}`,
        );
      }
      assertQuestion(course, question);
      gradedIds.add(grade.questionId);
      submittedQuestions.set(grade.questionId, question);
    }

    if (gradedIds.size !== draftIds.size) {
      throw new Error("Exam grades must exactly cover submitted drafts");
    }

    const history = await this.store.getHistory(course.id);
    const reviewedAt = this.clock.now();
    const operationId = this.operationId();

    await this.store.commitHistory(
      course.id,
      history.revision,
      operationId,
      (currentHistory) => {
        let nextHistory = {
          ...currentHistory,
          revision: currentHistory.revision + 1,
          attempts: [...currentHistory.attempts],
        };

        for (const grade of grades) {
          const question = submittedQuestions.get(grade.questionId);
          if (question === undefined) {
            throw new Error(
              `Grade references an exam item that was not submitted: ${grade.questionId}`,
            );
          }
          const draftEntry = exam.drafts[grade.questionId]!;
          const attempt = {
            id: this.ids.next("attempt"),
            operationId,
            kind: "answered" as const,
            question,
            mode: "exam" as const,
            submittedAt: draftEntry.submittedAt,
            answer: draftEntry.answer,
            confidence: draftEntry.confidence,
            unaidedAtSubmission: true,
            highestHintLevel: 0 as const,
            revealed: false,
            correctness: grade.correctness as Correctness,
            gradingRationale: grade.gradingRationale,
            ...(grade.misconception === undefined
              ? {}
              : { misconception: grade.misconception }),
          };
          nextHistory.attempts.push(attempt);

          const progress = nextHistory.concepts[question.targetConceptId] ?? {
            misconceptions: [],
          };
          const trackName = trackForAttempt(attempt);
          const updatedTrack =
            trackName === undefined
              ? undefined
              : this.scheduler.apply(
                  progress[trackName],
                  grade.correctness,
                  reviewedAt,
                );

          nextHistory = {
            ...nextHistory,
            concepts: {
              ...nextHistory.concepts,
              [question.targetConceptId]: {
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
                          sourceRef: question.sourceRefs[0],
                          lastSeenAt: reviewedAt.toISOString(),
                        },
                      ],
              },
            },
          };
        }

        return nextHistory;
      },
    );

    return activity(
      transition(current.state, {
        type: "examGraded",
      }),
    );
  }

  serializeActivity(current: SessionActivity): string {
    return this.codec.serialize(current);
  }

  restoreActivity(snapshot: string): SessionActivity {
    return this.codec.restore(snapshot);
  }

  private async courseFor(current: SessionActivity): Promise<Course> {
    return this.runtime.courseFor(current);
  }

  private operationId(): string {
    return this.runtime.operationId();
  }
}

function activity(state: ActivityState): SessionActivity {
  return { schemaVersion: 1, state };
}
