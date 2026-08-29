import { isAbsolute, normalize } from "node:path";

export type TutorMode = "study" | "drill" | "review" | "exam";
export type QuestionKind = "primary" | "transfer" | "exam";
export type Correctness = "correct" | "partial" | "incorrect" | "ungradable";
export type HintLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type FsrsTrackName = "unassisted" | "assisted";
export type PartialAnswerPolicy = "remediate" | "continue";

export interface SourceReference {
  materialId: string;
  path: string;
  locator: string;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  targetConceptId: string;
  prompt: string;
  sourceRefs: SourceReference[];
}

export interface Attempt {
  id: string;
  operationId: string;
  retryOfAttemptId?: string;
  question: Question;
  mode: TutorMode;
  submittedAt: string;
  answer: string;
  confidence: number;
  unaidedAtSubmission: boolean;
  highestHintLevel: HintLevel;
  revealed: boolean;
  correctness?: Correctness;
  gradingRationale?: string;
  misconception?: string;
  selfExplanation?: string;
  transferAttemptId?: string;
}

export interface FsrsTrack {
  card: Record<string, unknown>;
  reviewHistory: Array<{
    reviewedAt: string;
    rating: "Again" | "Hard" | "Good";
    log: Record<string, unknown>;
  }>;
}

export interface ConceptProgress {
  unassisted?: FsrsTrack;
  assisted?: FsrsTrack;
  misconceptions: Array<{
    text: string;
    sourceRef?: SourceReference;
    lastSeenAt: string;
    resolvedAt?: string;
  }>;
}

export interface CourseMaterial {
  id: string;
  path: string;
  addedAt: string;
}

export interface CourseConcept {
  id: string;
  name: string;
  parentId?: string;
  profileId?: string;
}

/** A model-proposed, source-cited concept that awaits learner approval. */
export interface CourseConceptProposal {
  id: string;
  name: string;
  parentId?: string;
  sourceRefs: SourceReference[];
}

export interface Course {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  appliedOperationIds: string[];
  partialAnswerPolicy: PartialAnswerPolicy;
  materials: CourseMaterial[];
  concepts: CourseConcept[];
  proposedConcepts: CourseConceptProposal[];
}

export interface LearningHistory {
  schemaVersion: 1;
  courseId: string;
  revision: number;
  appliedOperationIds: string[];
  attempts: Attempt[];
  concepts: Record<string, ConceptProgress>;
}

export interface CourseCatalog {
  schemaVersion: 1;
  revision: number;
  appliedOperationIds: string[];
  courseIds: string[];
  defaultCourseId?: string;
}

export interface SessionActivity {
  schemaVersion: 1;
  state: ActivityState;
}

export interface ModeOptions {
  deadlineAt?: string;
}

export interface Submission {
  answer: string;
  confidence: number;
}

export interface ExamGrade {
  questionId: string;
  correctness: Correctness;
  gradingRationale: string;
  misconception?: string;
}

export interface ParseError {
  message: string;
}

export interface ExamDraft {
  drafts: Record<string, Submission>;
}

export interface CalibrationBin {
  range: "0–24" | "25–49" | "50–74" | "75–100";
  attempts: number;
  meanConfidence?: number;
  fullyCorrectRate?: number;
}

export type UnaidedEvidence =
  "not demonstrated" | "emerging" | "established evidence";

export interface Dashboard {
  courseId: string;
  dueUnassisted: string[];
  dueAssisted: string[];
  unaidedCorrectRetrievalCount: number;
  unaidedEvidence: UnaidedEvidence;
  confidenceMeanAbsoluteError?: number;
  confidenceCalibration: CalibrationBin[];
  maximumHintLevel: HintLevel;
  hintReliance: { assistedAttempts: number; totalAttempts: number };
  misconceptions: Array<{ conceptId: string; text: string }>;
}

export type ActivityState =
  | { tag: "idle"; courseId?: string }
  | {
      tag: "awaiting-question";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      operationId: string;
    }
  | {
      tag: "awaiting-primary-answer";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      question: Question;
      hintLevel: HintLevel;
      revealed: boolean;
    }
  | {
      tag: "awaiting-grade";
      courseId: string;
      attemptId: string;
      purpose: "primary" | "transfer" | "explanation";
      question: Question;
      hintLevel: HintLevel;
      mode: Exclude<TutorMode, "exam">;
    }
  | {
      tag: "hint-requested";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      question: Question;
      nextHintLevel: Exclude<HintLevel, 0>;
      revealed: boolean;
    }
  | {
      tag: "reveal-requested";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      question: Question;
      hintLevel: HintLevel;
    }
  | {
      tag: "awaiting-correction";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      attemptId: string;
      question: Question;
      hintLevel: HintLevel;
    }
  | {
      tag: "awaiting-explanation";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      attemptId: string;
      question: Question;
      reason: "error" | "reveal";
    }
  | {
      tag: "awaiting-transfer";
      courseId: string;
      mode: Exclude<TutorMode, "exam">;
      parentAttemptId: string;
      operationId: string;
    }
  | {
      tag: "exam-generating";
      courseId: string;
      operationId: string;
      startedAt: string;
      deadlineAt?: string;
    }
  | { tag: "exam-active"; courseId: string; exam: ExamSession }
  | { tag: "exam-submitted"; courseId: string; exam: ExamSession };

export interface ExamSession {
  id: string;
  operationId: string;
  startedAt: string;
  deadlineAt?: string;
  submittedAt?: string;
  status: "active" | "submitted" | "expired" | "graded";
  items: Question[];
  drafts: Record<
    string,
    { answer: string; confidence: number; submittedAt: string }
  >;
}

export function assertCourseInvariant(course: Course): void {
  assertPartialAnswerPolicy(course.partialAnswerPolicy);
  assertUniqueCourseMaterialIds(course.materials);
  assertNormalizedMaterialPaths(course.materials);
  assertUniqueMaterialPaths(course.materials);
  assertUniqueConceptIds(course.concepts);
  assertUniqueConceptIds(course.proposedConcepts);

  const conceptIds = new Set(course.concepts.map(({ id }) => id));
  for (const proposal of course.proposedConcepts) {
    if (conceptIds.has(proposal.id)) {
      throw new Error(`Duplicate concept id: ${proposal.id}`);
    }
    conceptIds.add(proposal.id);
    assertNonEmptyString(proposal.id, "Concept ID");
    assertNonEmptyString(proposal.name, "Concept name");
    assertSourceReferences(course, proposal.sourceRefs, "Concept proposal");
  }

  const concepts = [...course.concepts, ...course.proposedConcepts];
  for (const concept of concepts) {
    if (concept.parentId === undefined) continue;
    if (concept.parentId === concept.id || !conceptIds.has(concept.parentId)) {
      throw new Error(`Unknown parent concept: ${concept.parentId}`);
    }
  }
  assertAcyclicConceptParents(concepts);
}

export function assertQuestion(course: Course, question: Question): void {
  assertCourseInvariant(course);

  if (!course.concepts.some(({ id }) => id === question.targetConceptId)) {
    throw new Error(`Unknown target concept: ${question.targetConceptId}`);
  }

  assertSourceReferences(course, question.sourceRefs, "Question");
}

/** True when an ID is safe in the line-oriented exam-draft header grammar. */
export function isGrammarSafeExamQuestionId(id: string): boolean {
  return (
    id.trim() !== "" &&
    id === id.trim() &&
    !/[\r\n]/.test(id) &&
    !["__proto__", "constructor", "prototype"].includes(id)
  );
}

function assertAcyclicConceptParents(
  concepts: readonly Pick<CourseConcept, "id" | "parentId">[],
): void {
  const parents = new Map(
    concepts.map(({ id, parentId }) => [id, parentId] as const),
  );
  for (const { id } of concepts) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new Error(`Concept parent cycle: ${id}`);
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
}

function assertSourceReferences(
  course: Course,
  sourceRefs: readonly SourceReference[],
  owner: string,
): void {
  if (sourceRefs.length === 0) {
    throw new Error(`${owner} must reference at least one configured material`);
  }

  for (const sourceRef of sourceRefs) {
    const material = course.materials.find(
      ({ id }) => id === sourceRef.materialId,
    );
    if (material === undefined) {
      throw new Error(`Unknown source material: ${sourceRef.materialId}`);
    }

    assertNormalizedPath(sourceRef.path, "Source path");
    if (sourceRef.path !== material.path) {
      throw new Error("Source path is not configured for this course");
    }
    assertNonEmptyString(sourceRef.locator, "Source locator");
  }
}

function assertPartialAnswerPolicy(
  value: unknown,
): asserts value is PartialAnswerPolicy {
  if (value !== "remediate" && value !== "continue") {
    throw new Error("Invalid partial answer policy");
  }
}

function assertUniqueCourseMaterialIds(
  materials: readonly CourseMaterial[],
): void {
  assertUnique(
    materials.map(({ id }) => id),
    "Duplicate material id",
  );
}

function assertNormalizedMaterialPaths(
  materials: readonly CourseMaterial[],
): void {
  for (const material of materials) {
    assertNormalizedPath(material.path, "Material path");
  }
}

function assertUniqueMaterialPaths(materials: readonly CourseMaterial[]): void {
  assertUnique(
    materials.map(({ path }) => path),
    "Duplicate material path",
  );
}

function assertUniqueConceptIds(
  concepts: readonly Pick<CourseConcept, "id">[],
): void {
  assertUnique(
    concepts.map(({ id }) => id),
    "Duplicate concept id",
  );
}

function assertUnique(values: readonly string[], errorPrefix: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${errorPrefix}: ${value}`);
    }
    seen.add(value);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }
}

function assertNormalizedPath(path: string, label: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error(`${label} must be absolute and normalized`);
  }
}
