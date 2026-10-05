import {
  assertQuestion,
  isGrammarSafeExamQuestionId,
  type Correctness,
  type ExamGrade,
  type ExamSession,
  type ModeOptions,
  type Question,
  type SessionActivity,
} from "../domain.js";
import { trackForAttempt } from "../scheduler.js";
import { transition } from "../state-machine.js";
import { ApplicationRuntime } from "./runtime.js";

export class ExamService {
  constructor(private readonly runtime: ApplicationRuntime) {}

  async requestMode(
    courseId: string,
    options: ModeOptions = {},
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

  async recordExam(
    current: SessionActivity,
    exam: ExamSession,
  ): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
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
    return this.runtime.activity(
      transition(current.state, { type: "examPresented", exam }),
    );
  }

  async saveExamDraft(
    current: SessionActivity,
    questionId: string,
    draft: ExamSession["drafts"][string],
  ): Promise<SessionActivity> {
    await this.runtime.courseFor(current);
    return this.runtime.activity(
      transition(current.state, {
        type: "examDraftAccepted",
        questionId,
        draft,
      }),
    );
  }

  async submitExam(current: SessionActivity): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
    if (current.state.tag !== "exam-active") {
      throw new Error("An exam can only be submitted while active");
    }

    const exam = current.state.exam;
    for (const question of exam.items) {
      assertQuestion(course, question);
    }
    const now = this.runtime.clock.now();
    const submittedAt = now.toISOString();
    const expired =
      exam.deadlineAt !== undefined && now > new Date(exam.deadlineAt);
    const omissions = exam.items.filter(
      ({ id }) => exam.drafts[id] === undefined,
    );

    if (omissions.length > 0) {
      const history = await this.runtime.store.getHistory(course.id);
      const operationId = this.runtime.operationId();
      const attempts = omissions.map((question) => ({
        id: this.runtime.ids.next("attempt"),
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

      await this.runtime.store.commitHistory(
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
            const unassisted = this.runtime.scheduler.apply(
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

    return this.runtime.activity(
      transition(current.state, {
        type: "examSubmitted",
        submittedAt,
        expired,
      }),
    );
  }

  async recordExamGrades(
    current: SessionActivity,
    grades: readonly ExamGrade[],
  ): Promise<SessionActivity> {
    const course = await this.runtime.courseFor(current);
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

    const history = await this.runtime.store.getHistory(course.id);
    const reviewedAt = this.runtime.clock.now();
    const operationId = this.runtime.operationId();

    await this.runtime.store.commitHistory(
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
            id: this.runtime.ids.next("attempt"),
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
              : this.runtime.scheduler.apply(
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

    return this.runtime.activity(
      transition(current.state, {
        type: "examGraded",
      }),
    );
  }
}
