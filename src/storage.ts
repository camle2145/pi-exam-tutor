import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  assertCourseInvariant,
  type Attempt,
  type ConceptProgress,
  type Course,
  type CourseCatalog,
  type FsrsTrack,
  type LearningHistory,
  type Question,
  type SourceReference,
} from "./domain.js";
import type { IdGenerator } from "./clock.js";

const SCHEMA_VERSION = 1;
const MAX_APPLIED_OPERATION_IDS = 100;
const LOCK_RETRY_COUNT = 50;
const LOCK_RETRY_DELAY_MS = 10;

export class RevisionConflictError extends Error {}

export interface Store {
  listCourses(): Promise<Course[]>;
  createCourse(name: string, operationId: string): Promise<Course>;
  getCourse(courseId: string): Promise<Course>;
  saveCourse(
    course: Course,
    expectedRevision: number,
    operationId: string,
  ): Promise<Course>;
  getHistory(courseId: string): Promise<LearningHistory>;
  commitHistory(
    courseId: string,
    expectedRevision: number,
    operationId: string,
    mutate: (history: LearningHistory) => LearningHistory,
  ): Promise<LearningHistory>;
}

export class LocalStore implements Store {
  constructor(
    private readonly root: string,
    private readonly ids: IdGenerator,
  ) {}

  async listCourses(): Promise<Course[]> {
    const catalog = await this.readCatalog();
    if (catalog === undefined) {
      return [];
    }

    return Promise.all(
      catalog.courseIds.map((courseId) => this.getCourse(courseId)),
    );
  }

  async createCourse(name: string, operationId: string): Promise<Course> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("Course name must not be empty");
    }
    assertOperationId(operationId);

    await mkdir(this.coursesRoot(), { recursive: true });
    return this.withLock(this.catalogLockPath(), async () => {
      const catalog = (await this.readCatalog()) ?? emptyCatalog();
      const replayed = await this.findCourseForOperation(operationId);
      if (replayed !== undefined) {
        await this.ensureHistory(replayed.id, operationId);
        if (!catalog.courseIds.includes(replayed.id)) {
          const repairedCatalog = {
            ...catalog,
            revision: catalog.revision + 1,
            appliedOperationIds: appendOperation(
              catalog.appliedOperationIds,
              operationId,
            ),
            courseIds: [...catalog.courseIds, replayed.id],
          };
          assertCatalog(repairedCatalog);
          await this.writeJson(
            this.catalogPath(),
            repairedCatalog,
            operationId,
          );
        }
        return replayed;
      }

      const courseId = await this.createCourseDirectory();
      const course = createCourse(courseId, name, operationId);
      const history = emptyHistory(courseId);

      try {
        return await this.withLock(this.courseLockPath(courseId), async () => {
          await this.writeJson(this.coursePath(courseId), course, operationId);
          await this.writeJson(
            this.historyPath(courseId),
            history,
            operationId,
          );

          const nextCatalog: CourseCatalog = {
            ...catalog,
            revision: catalog.revision + 1,
            appliedOperationIds: appendOperation(
              catalog.appliedOperationIds,
              operationId,
            ),
            courseIds: [...catalog.courseIds, courseId],
          };
          assertCatalog(nextCatalog);
          await this.writeJson(this.catalogPath(), nextCatalog, operationId);
          return course;
        });
      } catch (error) {
        // The course files are deliberately retained. A retry with the same
        // operation ID finds and completes this partially committed create.
        throw error;
      }
    });
  }

  async getCourse(courseId: string): Promise<Course> {
    assertCourseId(courseId);
    return this.readCourse(courseId);
  }

  async saveCourse(
    course: Course,
    expectedRevision: number,
    operationId: string,
  ): Promise<Course> {
    assertCourseId(course.id);
    assertOperationId(operationId);
    assertRevision(expectedRevision);

    return this.withCourseLock(course.id, async () => {
      const current = await this.readCourse(course.id);
      if (current.appliedOperationIds.includes(operationId)) {
        return current;
      }
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError("Course revision does not match");
      }

      assertCourse(course);
      if (course.revision !== expectedRevision + 1) {
        throw new Error("Course revision must advance by one");
      }
      const next: Course = {
        ...course,
        appliedOperationIds: appendOperation(
          mergeOperationIds(
            current.appliedOperationIds,
            course.appliedOperationIds,
          ),
          operationId,
        ),
      };
      assertCourse(next);
      await this.writeJson(this.coursePath(course.id), next, operationId);
      return next;
    });
  }

  async getHistory(courseId: string): Promise<LearningHistory> {
    assertCourseId(courseId);
    return this.readHistory(courseId);
  }

  async commitHistory(
    courseId: string,
    expectedRevision: number,
    operationId: string,
    mutate: (history: LearningHistory) => LearningHistory,
  ): Promise<LearningHistory> {
    assertCourseId(courseId);
    assertOperationId(operationId);
    assertRevision(expectedRevision);

    return this.withCourseLock(courseId, async () => {
      const current = await this.readHistory(courseId);
      if (current.appliedOperationIds.includes(operationId)) {
        return current;
      }
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(
          "Learning history revision does not match",
        );
      }

      const mutated = mutate(current);
      assertHistory(mutated);
      if (mutated.courseId !== courseId) {
        throw new Error("Learning history course ID cannot change");
      }
      if (mutated.revision !== expectedRevision + 1) {
        throw new Error("Learning history revision must advance by one");
      }
      const next: LearningHistory = {
        ...mutated,
        appliedOperationIds: appendOperation(
          mergeOperationIds(
            current.appliedOperationIds,
            mutated.appliedOperationIds,
          ),
          operationId,
        ),
      };
      assertHistory(next);
      await this.writeJson(this.historyPath(courseId), next, operationId);
      return next;
    });
  }

  private async readCatalog(): Promise<CourseCatalog | undefined> {
    const decoded = await this.readJson(this.catalogPath(), "catalog", true);
    if (decoded === undefined) {
      return undefined;
    }
    assertCatalog(decoded);
    return decoded;
  }

  private async readCourse(courseId: string): Promise<Course> {
    const course = await this.readCourseIfPresent(courseId);
    if (course === undefined) {
      throw new Error("Invalid course: file does not exist");
    }
    return course;
  }

  private async readCourseIfPresent(
    courseId: string,
  ): Promise<Course | undefined> {
    const decoded = await this.readJson(
      this.coursePath(courseId),
      "course",
      true,
    );
    if (decoded === undefined) {
      return undefined;
    }
    assertCourse(decoded);
    if (decoded.id !== courseId) {
      throw new Error("Invalid course: course ID does not match its path");
    }
    return decoded;
  }

  private async readHistory(courseId: string): Promise<LearningHistory> {
    const decoded = await this.readJson(
      this.historyPath(courseId),
      "learning history",
    );
    assertHistory(decoded);
    if (decoded.courseId !== courseId) {
      throw new Error(
        "Invalid learning history: course ID does not match its path",
      );
    }
    return decoded;
  }

  private async readJson(
    path: string,
    label: string,
    missingIsUndefined = false,
  ): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (missingIsUndefined && isFileNotFound(error)) {
        return undefined;
      }
      if (isFileNotFound(error)) {
        throw new Error(`Invalid ${label}: file does not exist`);
      }
      throw error;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid ${label}: invalid JSON`);
    }
  }

  private async writeJson(
    path: string,
    value: object,
    operationId: string,
  ): Promise<void> {
    const temporaryPath = `${path}.tmp-${safeOperationFileSuffix(operationId)}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  }

  private async withCourseLock<T>(
    courseId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(this.courseLockPath(courseId), action);
  }

  private async withLock<T>(
    lockPath: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      try {
        lock = await open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error) || attempt === LOCK_RETRY_COUNT - 1) {
          throw error;
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    if (lock === undefined) {
      throw new Error(`Unable to acquire storage lock: ${lockPath}`);
    }

    try {
      return await action();
    } finally {
      try {
        await lock.close();
      } finally {
        await unlink(lockPath).catch((error: unknown) => {
          if (!isFileNotFound(error)) {
            throw error;
          }
        });
      }
    }
  }

  private async ensureHistory(
    courseId: string,
    operationId: string,
  ): Promise<void> {
    await this.withCourseLock(courseId, async () => {
      const decoded = await this.readJson(
        this.historyPath(courseId),
        "learning history",
        true,
      );
      if (decoded === undefined) {
        await this.writeJson(
          this.historyPath(courseId),
          emptyHistory(courseId),
          operationId,
        );
        return;
      }
      assertHistory(decoded);
      if (decoded.courseId !== courseId) {
        throw new Error(
          "Invalid learning history: course ID does not match its path",
        );
      }
    });
  }

  private async createCourseDirectory(): Promise<string> {
    for (;;) {
      const courseId = this.ids.next("course");
      assertCourseId(courseId);
      try {
        await mkdir(this.courseDirectory(courseId));
        return courseId;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
    }
  }

  private async findCourseForOperation(
    operationId: string,
  ): Promise<Course | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.coursesRoot());
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!isCourseId(entry)) {
        continue;
      }
      const course = await this.readCourseIfPresent(entry);
      if (course?.appliedOperationIds.includes(operationId)) {
        return course;
      }
    }
    return undefined;
  }

  private catalogPath(): string {
    return join(this.root, "catalog.json");
  }

  private catalogLockPath(): string {
    return join(this.root, ".catalog.lock");
  }

  private coursesRoot(): string {
    return join(this.root, "courses");
  }

  private courseDirectory(courseId: string): string {
    return join(this.coursesRoot(), courseId);
  }

  private coursePath(courseId: string): string {
    return join(this.courseDirectory(courseId), "course.json");
  }

  private historyPath(courseId: string): string {
    return join(this.courseDirectory(courseId), "learning.json");
  }

  private courseLockPath(courseId: string): string {
    return join(this.courseDirectory(courseId), ".lock");
  }
}

function createCourse(id: string, name: string, operationId: string): Course {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    revision: 0,
    createdAt: new Date().toISOString(),
    appliedOperationIds: [operationId],
    partialAnswerPolicy: "remediate",
    materials: [],
    concepts: [],
  };
}

function emptyCatalog(): CourseCatalog {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    appliedOperationIds: [],
    courseIds: [],
  };
}

function emptyHistory(courseId: string): LearningHistory {
  return {
    schemaVersion: SCHEMA_VERSION,
    courseId,
    revision: 0,
    appliedOperationIds: [],
    attempts: [],
    concepts: {},
  };
}

function appendOperation(
  operationIds: string[],
  operationId: string,
): string[] {
  return [
    ...operationIds.filter((id) => id !== operationId),
    operationId,
  ].slice(-MAX_APPLIED_OPERATION_IDS);
}

function mergeOperationIds(first: string[], second: string[]): string[] {
  return [...first, ...second].filter(
    (operationId, index, all) => all.indexOf(operationId) === index,
  );
}

function assertCatalog(value: unknown): asserts value is CourseCatalog {
  try {
    if (
      !isRecord(value) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      !isRevision(value.revision) ||
      !isOperationIds(value.appliedOperationIds) ||
      !isStringArray(value.courseIds) ||
      !value.courseIds.every(isCourseId) ||
      (value.defaultCourseId !== undefined &&
        !isCourseId(value.defaultCourseId)) ||
      new Set(value.courseIds).size !== value.courseIds.length
    ) {
      throw new Error("shape");
    }
  } catch {
    throw new Error("Invalid catalog");
  }
}

function assertCourse(value: unknown): asserts value is Course {
  try {
    if (
      !isRecord(value) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      !isCourseId(value.id) ||
      typeof value.name !== "string" ||
      !isRevision(value.revision) ||
      typeof value.createdAt !== "string" ||
      !isOperationIds(value.appliedOperationIds) ||
      !isPartialAnswerPolicy(value.partialAnswerPolicy) ||
      !Array.isArray(value.materials) ||
      !value.materials.every(isCourseMaterial) ||
      !Array.isArray(value.concepts) ||
      !value.concepts.every(isCourseConcept)
    ) {
      throw new Error("shape");
    }
    assertCourseInvariant(value as unknown as Course);
  } catch {
    throw new Error("Invalid course");
  }
}

function assertHistory(value: unknown): asserts value is LearningHistory {
  try {
    if (
      !isRecord(value) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      !isCourseId(value.courseId) ||
      !isRevision(value.revision) ||
      !isOperationIds(value.appliedOperationIds) ||
      !Array.isArray(value.attempts) ||
      !value.attempts.every(isAttempt) ||
      !isRecord(value.concepts) ||
      !Object.values(value.concepts).every(isConceptProgress)
    ) {
      throw new Error("shape");
    }
  } catch {
    throw new Error("Invalid learning history");
  }
}

function isCourseMaterial(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.addedAt === "string"
  );
}

function isCourseConcept(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.profileId === undefined || typeof value.profileId === "string")
  );
}

function isAttempt(value: unknown): value is Attempt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.operationId === "string" &&
    (value.retryOfAttemptId === undefined ||
      typeof value.retryOfAttemptId === "string") &&
    isQuestion(value.question) &&
    isTutorMode(value.mode) &&
    typeof value.submittedAt === "string" &&
    typeof value.answer === "string" &&
    typeof value.confidence === "number" &&
    typeof value.unaidedAtSubmission === "boolean" &&
    isHintLevel(value.highestHintLevel) &&
    typeof value.revealed === "boolean" &&
    (value.correctness === undefined || isCorrectness(value.correctness)) &&
    (value.gradingRationale === undefined ||
      typeof value.gradingRationale === "string") &&
    (value.misconception === undefined ||
      typeof value.misconception === "string") &&
    (value.selfExplanation === undefined ||
      typeof value.selfExplanation === "string") &&
    (value.transferAttemptId === undefined ||
      typeof value.transferAttemptId === "string")
  );
}

function isQuestion(value: unknown): value is Question {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "primary" ||
      value.kind === "transfer" ||
      value.kind === "exam") &&
    typeof value.targetConceptId === "string" &&
    typeof value.prompt === "string" &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every(isSourceReference)
  );
}

function isSourceReference(value: unknown): value is SourceReference {
  return (
    isRecord(value) &&
    typeof value.materialId === "string" &&
    typeof value.path === "string" &&
    typeof value.locator === "string"
  );
}

function isConceptProgress(value: unknown): value is ConceptProgress {
  return (
    isRecord(value) &&
    (value.unassisted === undefined || isFsrsTrack(value.unassisted)) &&
    (value.assisted === undefined || isFsrsTrack(value.assisted)) &&
    Array.isArray(value.misconceptions) &&
    value.misconceptions.every(
      (misconception) =>
        isRecord(misconception) &&
        typeof misconception.text === "string" &&
        (misconception.sourceRef === undefined ||
          isSourceReference(misconception.sourceRef)) &&
        typeof misconception.lastSeenAt === "string" &&
        (misconception.resolvedAt === undefined ||
          typeof misconception.resolvedAt === "string"),
    )
  );
}

function isFsrsTrack(value: unknown): value is FsrsTrack {
  return (
    isRecord(value) &&
    isRecord(value.card) &&
    Array.isArray(value.reviewHistory) &&
    value.reviewHistory.every(
      (review) =>
        isRecord(review) &&
        typeof review.reviewedAt === "string" &&
        (review.rating === "Again" ||
          review.rating === "Hard" ||
          review.rating === "Good") &&
        isRecord(review.log),
    )
  );
}

function isTutorMode(value: unknown): boolean {
  return (
    value === "study" ||
    value === "drill" ||
    value === "review" ||
    value === "exam"
  );
}

function isPartialAnswerPolicy(value: unknown): boolean {
  return value === "remediate" || value === "continue";
}

function isCorrectness(value: unknown): boolean {
  return (
    value === "correct" ||
    value === "partial" ||
    value === "incorrect" ||
    value === "ungradable"
  );
}

function isHintLevel(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 6
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertRevision(value: number): void {
  if (!isRevision(value)) {
    throw new Error("Expected revision must be a non-negative integer");
  }
}

function isOperationIds(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length <= MAX_APPLIED_OPERATION_IDS &&
    new Set(value).size === value.length
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function assertOperationId(operationId: string): void {
  if (
    typeof operationId !== "string" ||
    operationId === "" ||
    operationId.includes("\0")
  ) {
    throw new Error("Operation ID must be a non-empty string");
  }
}

function assertCourseId(courseId: string): void {
  if (!isCourseId(courseId)) {
    throw new Error("Invalid course ID");
  }
}

function isCourseId(courseId: unknown): courseId is string {
  return (
    typeof courseId === "string" &&
    courseId !== "" &&
    courseId !== "." &&
    courseId !== ".." &&
    !courseId.includes("\0") &&
    !courseId.includes("/") &&
    !courseId.includes("\\") &&
    basename(courseId) === courseId
  );
}

function safeOperationFileSuffix(operationId: string): string {
  return encodeURIComponent(operationId);
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function isFileNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
