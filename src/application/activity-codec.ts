import {
  isGrammarSafeExamQuestionId,
  type ExamSession,
  type SessionActivity,
} from "../domain.js";

export class ActivityCodec {
  assert(value: unknown): asserts value is SessionActivity {
    assertActivity(value);
  }

  serialize(current: SessionActivity): string {
    this.assert(current);
    return JSON.stringify(current);
  }

  restore(snapshot: string): SessionActivity {
    const decoded = parseSnapshot(snapshot);
    this.assert(decoded);
    return JSON.parse(JSON.stringify(decoded)) as SessionActivity;
  }
}

function parseSnapshot(snapshot: string): unknown {
  try {
    return JSON.parse(snapshot) as unknown;
  } catch {
    throw new Error("Invalid activity snapshot");
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
