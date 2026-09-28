import { isAbsolute, normalize } from "node:path";
import type { Clock, IdGenerator } from "./clock.js";
import {
  assertCourseInvariant,
  assertQuestion,
  isAnsweredAttempt,
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

type RegularSubmission = Omit<Submission, "confidence"> & {
  confidence?: number;
};

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
    submission: RegularSubmission,
  ): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    const details = submissionDetails(current.state);
    assertSubmission(submission, details.requiresConfidence);
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

  async recordSolution(current: SessionActivity): Promise<SessionActivity> {
    const course = await this.courseFor(current);
    if (current.state.tag !== "reveal-requested") {
      throw new Error("A solution is not currently requested");
    }
    const state = current.state;
    assertQuestion(course, state.question);

    const attemptId = this.ids.next("attempt");
    const operationId = this.operationId();
    const next = transition(state, {
      type: "solutionPresented",
      attemptId,
    });
    const history = await this.store.getHistory(course.id);
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
    return activity(next);
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
    if (!isAnsweredAttempt(original)) {
      throw new Error(`Attempt cannot be graded: ${original.id}`);
    }
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
    if (proposals.length === 0) {
      throw new Error("Must propose at least one concept");
    }
    for (const proposal of proposals) {
      if (typeof proposal.id !== "string" || proposal.id.trim() === "") {
        throw new Error("Each proposal must have a nonempty ID");
      }
      if (typeof proposal.name !== "string" || proposal.name.trim() === "") {
        throw new Error("Each proposal must have a nonempty name");
      }
      if (
        !Array.isArray(proposal.sourceRefs) ||
        proposal.sourceRefs.length === 0
      ) {
        throw new Error(
          "Each proposal must cite at least one configured material",
        );
      }
    }

    const course = await this.store.getCourse(courseId);

    const allIds = new Set(course.concepts.map(({ id }) => id));
    for (const proposal of proposals) {
      if (allIds.has(proposal.id)) {
        throw new Error(`Duplicate concept id: ${proposal.id}`);
      }
      allIds.add(proposal.id);
    }

    for (const proposal of proposals) {
      if (proposal.parentId !== undefined && !allIds.has(proposal.parentId)) {
        throw new Error(`Unknown parent concept: ${proposal.parentId}`);
      }
    }

    for (const proposal of proposals) {
      for (const sourceRef of proposal.sourceRefs) {
        const material = course.materials.find(
          ({ id }) => id === sourceRef.materialId,
        );
        if (material === undefined) {
          throw new Error(`Unknown source material: ${sourceRef.materialId}`);
        }
        if (sourceRef.path !== material.path) {
          throw new Error(
            `Source path must match the configured material path: ${sourceRef.path}`,
          );
        }
      }
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: [...proposals],
    };
    assertCourseInvariant(next);
    return this.store.saveCourse(next, course.revision, this.operationId());
  }

  async approveConcepts(
    courseId: string,
    conceptIds: readonly string[],
  ): Promise<Course> {
    const course = await this.store.getCourse(courseId);

    if (conceptIds.length === 0) {
      conceptIds = course.proposedConcepts.map(({ id }) => id);
    }

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    for (const id of conceptIds) {
      if (!byId.has(id)) {
        throw new Error(`No pending proposal: ${id}`);
      }
    }

    const approved: Course["concepts"] = conceptIds.map((id) => {
      const proposal = byId.get(id)!;
      return {
        id: proposal.id,
        name: proposal.name,
        parentId: proposal.parentId,
      };
    });

    const removedIds = new Set(conceptIds);
    const next: Course = {
      ...course,
      revision: course.revision + 1,
      concepts: [...course.concepts, ...approved],
      proposedConcepts: course.proposedConcepts.filter(
        ({ id }) => !removedIds.has(id),
      ),
    };
    assertCourseInvariant(next);
    return this.store.saveCourse(next, course.revision, this.operationId());
  }

  async editProposedConcept(
    courseId: string,
    conceptId: string,
    update: { name?: string; parentId?: string | null },
  ): Promise<Course> {
    const course = await this.store.getCourse(courseId);

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    if (!byId.has(conceptId)) {
      throw new Error(`No pending proposal: ${conceptId}`);
    }

    const merged: CourseConceptProposal = {
      ...byId.get(conceptId)!,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.parentId === undefined
        ? {}
        : update.parentId === null
          ? { parentId: undefined }
          : { parentId: update.parentId }),
    };

    const allIds = new Set([
      ...course.concepts.map(({ id }) => id),
      ...course.proposedConcepts.map(({ id }) => id),
    ]);
    if (
      merged.parentId !== undefined &&
      merged.parentId !== merged.id &&
      !allIds.has(merged.parentId)
    ) {
      throw new Error(`Unknown parent concept: ${merged.parentId}`);
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: course.proposedConcepts.map((c) =>
        c.id === conceptId ? merged : c,
      ),
    };
    assertCourseInvariant(next);
    return this.store.saveCourse(next, course.revision, this.operationId());
  }

  async removeProposedConcept(
    courseId: string,
    conceptId: string,
  ): Promise<Course> {
    const course = await this.store.getCourse(courseId);

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    if (!byId.has(conceptId)) {
      throw new Error(`No pending proposal: ${conceptId}`);
    }

    for (const proposal of course.proposedConcepts) {
      if (proposal.parentId === conceptId) {
        throw new Error(
          `Cannot remove concept that is a parent of: ${proposal.id}`,
        );
      }
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: course.proposedConcepts.filter(
        ({ id }) => id !== conceptId,
      ),
    };
    assertCourseInvariant(next);
    return this.store.saveCourse(next, course.revision, this.operationId());
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

function assertActivity(value: unknown): asserts value is SessionActivity {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.state)) {
    invalidActivity();
  }

  const state = value.state;
  switch (state.tag) {
    case "idle":
      if (state.courseId !== undefined) assertNonEmptyString(state.courseId);
      return;
    case "awaiting-question":
      assertCourseModeState(state, true);
      assertNonEmptyString(state.operationId);
      return;
    case "awaiting-primary-answer":
      assertCourseModeState(state, true);
      assertActivityQuestion(state.question);
      assertHintLevel(state.hintLevel);
      assertBoolean(state.revealed);
      return;
    case "awaiting-grade":
      assertCourseModeState(state, true);
      assertNonEmptyString(state.attemptId);
      assertOneOf(state.purpose, ["primary", "transfer", "explanation"]);
      assertActivityQuestion(state.question);
      assertHintLevel(state.hintLevel);
      return;
    case "hint-requested":
      assertCourseModeState(state, true);
      assertActivityQuestion(state.question);
      assertHintLevel(state.nextHintLevel, false);
      assertBoolean(state.revealed);
      return;
    case "reveal-requested":
      assertCourseModeState(state, true);
      assertActivityQuestion(state.question);
      assertHintLevel(state.hintLevel);
      return;
    case "awaiting-correction":
      assertCourseModeState(state, true);
      assertNonEmptyString(state.attemptId);
      assertActivityQuestion(state.question);
      assertHintLevel(state.hintLevel);
      return;
    case "awaiting-explanation":
      assertCourseModeState(state, true);
      assertNonEmptyString(state.attemptId);
      assertActivityQuestion(state.question);
      assertOneOf(state.reason, ["error", "reveal"]);
      return;
    case "awaiting-transfer":
      assertCourseModeState(state, true);
      assertNonEmptyString(state.parentAttemptId);
      assertNonEmptyString(state.operationId);
      return;
    case "exam-generating":
      assertCourseId(state);
      assertNonEmptyString(state.operationId);
      assertIsoTimestamp(state.startedAt);
      if (state.deadlineAt !== undefined) assertIsoTimestamp(state.deadlineAt);
      return;
    case "exam-active":
      assertCourseId(state);
      assertExamSession(state.exam);
      if (
        state.exam.status !== "active" ||
        state.exam.submittedAt !== undefined
      ) {
        invalidActivity();
      }
      return;
    case "exam-submitted":
      assertCourseId(state);
      assertExamSession(state.exam);
      if (
        !["submitted", "expired", "graded"].includes(state.exam.status) ||
        state.exam.submittedAt === undefined
      ) {
        invalidActivity();
      }
      return;
    default:
      invalidActivity();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCourseModeState(
  state: Record<string, unknown>,
  nonExamMode: boolean,
): void {
  assertCourseId(state);
  assertOneOf(
    state.mode,
    nonExamMode ? ["study", "drill", "review"] : ["exam"],
  );
}

function assertCourseId(state: Record<string, unknown>): void {
  assertNonEmptyString(state.courseId);
}

function assertActivityQuestion(value: unknown): void {
  if (!isRecord(value)) invalidActivity();
  assertNonEmptyString(value.id);
  assertOneOf(value.kind, ["primary", "transfer", "exam"]);
  assertNonEmptyString(value.targetConceptId);
  assertNonEmptyString(value.prompt);
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) {
    invalidActivity();
  }
  for (const sourceRef of value.sourceRefs) {
    if (!isRecord(sourceRef)) invalidActivity();
    assertNonEmptyString(sourceRef.materialId);
    assertNonEmptyString(sourceRef.path);
    assertNonEmptyString(sourceRef.locator);
  }
}

function assertExamSession(value: unknown): asserts value is ExamSession {
  if (!isRecord(value)) invalidActivity();
  assertNonEmptyString(value.id);
  assertNonEmptyString(value.operationId);
  assertIsoTimestamp(value.startedAt);
  if (value.deadlineAt !== undefined) assertIsoTimestamp(value.deadlineAt);
  if (value.submittedAt !== undefined) assertIsoTimestamp(value.submittedAt);
  assertOneOf(value.status, ["active", "submitted", "expired", "graded"]);
  if (!Array.isArray(value.items)) invalidActivity();
  const itemIds = new Set<string>();
  for (const question of value.items) {
    assertActivityQuestion(question);
    if (
      question.kind !== "exam" ||
      !isGrammarSafeExamQuestionId(question.id) ||
      itemIds.has(question.id)
    ) {
      invalidActivity();
    }
    itemIds.add(question.id);
  }
  if (!isRecord(value.drafts)) invalidActivity();
  for (const [questionId, draft] of Object.entries(value.drafts)) {
    if (!itemIds.has(questionId)) invalidActivity();
    if (!isRecord(draft)) invalidActivity();
    assertNonEmptyString(draft.answer);
    if (
      typeof draft.confidence !== "number" ||
      !Number.isFinite(draft.confidence) ||
      draft.confidence < 0 ||
      draft.confidence > 100
    ) {
      invalidActivity();
    }
    assertIsoTimestamp(draft.submittedAt);
  }
}

function assertHintLevel(value: unknown, allowZero = true): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 6
  ) {
    invalidActivity();
  }
}

function assertIsoTimestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalidActivity();
  }
}

function assertBoolean(value: unknown): void {
  if (typeof value !== "boolean") invalidActivity();
}

function assertNonEmptyString(value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") invalidActivity();
}

function assertOneOf(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) invalidActivity();
}

function invalidActivity(): never {
  throw new Error("Invalid activity snapshot");
}
