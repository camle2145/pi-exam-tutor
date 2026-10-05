import { ActivityCodec } from "./application/activity-codec.js";
import { CourseService } from "./application/course-service.js";
import { ExamService } from "./application/exam-service.js";
import {
  LearningService,
  type Grade,
  type RegularSubmission,
} from "./application/learning-service.js";
import { ApplicationRuntime } from "./application/runtime.js";
import type { Clock, IdGenerator } from "./clock.js";
import type {
  Course,
  CourseConceptProposal,
  ExamGrade,
  ExamSession,
  HintLevel,
  ModeOptions,
  Question,
  SessionActivity,
  TutorMode,
} from "./domain.js";
import { scheduler as defaultScheduler, type Scheduler } from "./scheduler.js";
import type { Store } from "./storage.js";

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
  saveExamDraft(
    activity: SessionActivity,
    questionId: string,
    draft: ExamSession["drafts"][string],
  ): Promise<SessionActivity>;
  submitExam(activity: SessionActivity): Promise<SessionActivity>;
  proposeConcepts(
    courseId: string,
    proposals: readonly CourseConceptProposal[],
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
    grades: readonly ExamGrade[],
  ): Promise<SessionActivity>;
  serializeActivity(activity: SessionActivity): string;
  restoreActivity(snapshot: string): SessionActivity;
}

export class TutorApplicationService implements TutorApplication {
  private readonly codec = new ActivityCodec();
  private readonly runtime: ApplicationRuntime;
  private readonly courses: CourseService;
  private readonly learning: LearningService;
  private readonly exams: ExamService;

  constructor(
    store: Store,
    clock: Clock,
    ids: IdGenerator,
    scheduler: Scheduler = defaultScheduler,
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
    this.exams = new ExamService(this.runtime);
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
      ? this.exams.requestMode(courseId, options)
      : this.learning.requestMode(courseId, mode, options);
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
    activity: SessionActivity,
    exam: ExamSession,
  ): Promise<SessionActivity> {
    return this.exams.recordExam(activity, exam);
  }

  async saveExamDraft(
    activity: SessionActivity,
    questionId: string,
    draft: ExamSession["drafts"][string],
  ): Promise<SessionActivity> {
    return this.exams.saveExamDraft(activity, questionId, draft);
  }

  async submitExam(activity: SessionActivity): Promise<SessionActivity> {
    return this.exams.submitExam(activity);
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
    activity: SessionActivity,
    grades: readonly ExamGrade[],
  ): Promise<SessionActivity> {
    return this.exams.recordExamGrades(activity, grades);
  }

  serializeActivity(activity: SessionActivity): string {
    return this.codec.serialize(activity);
  }

  restoreActivity(snapshot: string): SessionActivity {
    return this.codec.restore(snapshot);
  }
}
