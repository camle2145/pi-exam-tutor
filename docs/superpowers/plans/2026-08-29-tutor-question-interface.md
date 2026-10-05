# Tutor Question Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace interactive confidence-header answer syntax with a compact Pi-native response flow while preserving the tutor protocol, making partial exams auditable, and keeping all grading and scheduling boundaries deterministic.

**Architecture:** Keep learning evidence in the application core and make the extension a state-driven response controller. The controller opens a compact, bottom-anchored response panel only after the agent settles, persists an answer only after its required confidence is confirmed, and sends a custom transcript message containing the canonical learner payload. The core records deterministic unanswered exam outcomes at submission; the model grades only submitted answers.

**Tech Stack:** TypeScript (strict), Vitest, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, TypeBox, `ts-fsrs`.

## Global Constraints

- Do not depend on `@juicesharp/rpiv-ask-user-question`; its compact-questionnaire UX is visual inspiration only.
- In TUI mode, open a bare, compact panel above Pi’s editor after `agent_settled`; it must not repeat the question or citation.
- The answer editor is multiline, fixed at 5–7 visible rows with internal scrolling. `Enter` continues, `Shift+Enter` inserts a newline, and `Escape` defers the panel.
- A regular or transfer response is committed only after its answer and 0–100 confidence are both confirmed. The confidence screen shows an unconfirmed `50`; first Left/Right yields `45`/`55`, later arrows move in five-point steps, and typed integers replace the value.
- A correction uses the same answer editor but does **not** ask for confidence unless a later change makes corrections gradeable.
- Incomplete panel data remains adapter-memory-only and is discarded on session reload. A deferred normal-editor submission must be restored to the editor after the resume notice, never silently lost.
- `/resume-answer` is the explicit resume command. While deferred, ordinary input must not reach the model and must restore its typed text after notifying the learner.
- Questions, feedback, hints, and solutions render expanded. Learner response messages render as Pi-expandable custom messages: a one-line summary collapsed by default and the full answer after Pi’s standard `Ctrl+O` expansion.
- Exam active-item cards show prompt only—never source path or locator. Exact citations remain stored and appear after aggregate grading.
- Exam answers save one item at a time, advance to the next unanswered item, and can be revised. An answer revision must reconfirm a prefilled confidence before replacing the saved draft.
- Manual exam submission always opens review. It allows partial submission, but a pending in-memory edit blocks submission until the learner resumes or discards it. Deadline submission bypasses review and uses only fully committed drafts.
- Every omitted exam item becomes a core-recorded `unanswered` outcome with `manual-partial` or `deadline` reason. It is reported separately, excluded from confidence calibration, and produces at most one unaided FSRS `Again` update per target concept for an exam submission.
- Keep RPC support through `ctx.ui.editor()` and `ctx.ui.input()` dialogs. Keep the existing header grammar only as the documented no-UI fallback.
- Preserve course separation, atomic persistence, source validation, canonical tool boundaries, exam feedback isolation, and all existing tutor state-machine guarantees.
- Use TDD: every behavior change starts with a focused failing test; run the relevant suite before each commit and the full formatter/typecheck/test suite before the final commit.

## Implementation Status

**Audited ref:** `feat/tutor-question-interface` at `ed42531`.

- [x] Tasks 1–3 — discriminated unanswered evidence, migration, omission scheduling, dashboard reporting, and submission persistence.
- [~] Task 4 — the compact collector is implemented, but this branch initializes an edited answer's confidence at `50` instead of prefilling the prior confidence for explicit reconfirmation.
- [ ] Tasks 5–7 — not implemented on this branch. Their settled-event controller, resume flow, per-item exam review, and interactive-first documentation were completed later on `main`.
- [x] Current branch verification — `format:check`, `typecheck`, tests (113), and `git diff --check` passed; this does not make the remaining plan scope complete.

The original checklist remains as the implementation record; this branch-status section is authoritative.

---

## File Structure

```text
src/domain.ts                         Discriminated persisted attempts and unanswered-exam metadata
src/storage.ts                        Decode legacy attempts and validate discriminated attempt records
src/scheduler.ts                      Map explicit unanswered outcomes to one unaided Again review
src/dashboard.ts                      Exclude no-confidence outcomes from calibration and report omissions
src/application.ts                    Persist omission outcomes at submit and grade only submitted answers
src/response-ui.ts                    Compact answer/confidence panels plus RPC dialog collection
src/ui.ts                             Quiet deferred-response widget and shared status presentation
extensions/exam-tutor/index.ts        State-driven response controller, active exam cards, review, custom messages
README.md                             Interactive workflow, fallback syntax, partial-exam and citation semantics
test/application.test.ts              Omission persistence, scheduling, calibration, and correction evidence
test/storage.test.ts                  Legacy migration and discriminated-attempt persistence
test/scheduler.test.ts                Unanswered scheduling behavior
test/response-ui.test.ts              Panel keyboard/value behavior and RPC/no-UI collection seams
test/extension.test.ts                Controller lifecycle, cards, review, renderer, and fallback behavior
```

The new `src/response-ui.ts` owns focused collection only. It must not persist activity, decide whether an answer is legal, call the model, or mutate exam drafts. `extensions/exam-tutor/index.ts` owns transient drafts, active exam navigation, persistence calls, and message delivery. The application service owns durable evidence, omission records, and scheduling.

## Data Contracts

Define these contracts before adapter work so UI cannot manufacture invalid evidence:

```ts
export type Attempt = AnsweredAttempt | UnansweredAttempt;

interface AttemptBase {
  id: string;
  operationId: string;
  retryOfAttemptId?: string;
  question: Question;
  mode: TutorMode;
  submittedAt: string;
  unaidedAtSubmission: boolean;
  highestHintLevel: HintLevel;
  revealed: boolean;
  selfExplanation?: string;
  transferAttemptId?: string;
}

export interface AnsweredAttempt extends AttemptBase {
  kind: "answered";
  answer: string;
  /** Required for primary, transfer, and exam attempts; absent for ungraded corrections. */
  confidence?: number;
  correctness?: Correctness;
  gradingRationale?: string;
  misconception?: string;
}

export interface UnansweredAttempt extends AttemptBase {
  kind: "unanswered";
  omissionReason: "manual-partial" | "deadline";
}

export type Submission =
  | { answer: string; confidence: number }
  | { answer: string; confidence?: undefined };
```

`LearningHistory.schemaVersion` becomes `2`. On read, migrate every valid version-1 attempt to `{ ...attempt, kind: "answered" }`. A version-2 learning history must contain only the union above. Do not convert an omission into `answer: ""`, `confidence: 0`, or `correctness: "ungradable"`.

---

### Task 1: Model and migrate explicit unanswered evidence

**Files:**

- Modify: `src/domain.ts`
- Modify: `src/storage.ts`
- Modify: `src/application.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/dashboard.ts`
- Modify: `test/storage.test.ts`
- Modify: `test/state-machine.test.ts`
- Modify: `test/application.test.ts`

**Interfaces:**

- Produces `AnsweredAttempt`, `UnansweredAttempt`, `Attempt`, `OmissionReason`, and version-2 `LearningHistory`.
- Produces `migrateLearningHistory(value: unknown): LearningHistory` (or a private decoder with this behavior) used before validation returns persisted data.
- Maintains `SessionActivity.schemaVersion: 1`; active-session format is unchanged in this task.

- [ ] **Step 1: Write the migration and validation tests**

```ts
test("migrates a version-1 answered attempt without changing its evidence", async () => {
  await writeFile(
    learningPath,
    JSON.stringify({
      ...history,
      schemaVersion: 1,
      attempts: [{ ...attempt, answer: "x", confidence: 70 }],
    }),
  );

  await expect(store.getHistory(course.id)).resolves.toMatchObject({
    schemaVersion: 2,
    attempts: [{ kind: "answered", answer: "x", confidence: 70 }],
  });
});

test("accepts an unanswered attempt without an answer or confidence", async () => {
  const saved = await store.commitHistory(
    course.id,
    0,
    "op-blank",
    (value) => ({
      ...value,
      revision: 1,
      attempts: [
        {
          id: "attempt-blank",
          operationId: "op-blank",
          kind: "unanswered",
          question,
          mode: "exam",
          submittedAt: now.toISOString(),
          unaidedAtSubmission: true,
          highestHintLevel: 0,
          revealed: false,
          omissionReason: "manual-partial",
        },
      ],
    }),
  );

  expect(saved.attempts[0]).toMatchObject({ kind: "unanswered" });
});

test("rejects an unanswered attempt that carries confidence", async () => {
  // Write a schemaVersion: 2 history with kind: "unanswered" and confidence: 0.
  await expect(store.getHistory(course.id)).rejects.toThrow(
    "Invalid learning history",
  );
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- test/storage.test.ts test/state-machine.test.ts`

Expected: FAIL because schema version 2, `kind`, and migration are not implemented.

- [ ] **Step 3: Implement the discriminated data model**

In `src/domain.ts`:

```ts
export type OmissionReason = "manual-partial" | "deadline";
export type Attempt = AnsweredAttempt | UnansweredAttempt;

export function isAnsweredAttempt(
  attempt: Attempt,
): attempt is AnsweredAttempt {
  return attempt.kind === "answered";
}
```

Update every existing attempt construction in `src/application.ts` to set `kind: "answered"`. Make `confidence` optional only on `AnsweredAttempt`; all callers that record primary, transfer, and exam evidence will still validate that it is present. Keep correction attempts representable without inventing a confidence score.

In this same compile-green task, narrow `Attempt` in `src/scheduler.ts` and `src/dashboard.ts` before accessing answered-only fields. Preserve their current behavior for answered records; Task 2 adds the omission-specific behavior and dashboard projection. Add a focused application test proving primary submissions still persist `{ kind: "answered", confidence: 70 }`.

In `src/storage.ts`, decode `LearningHistory` by:

1. Parsing JSON.
2. Converting `schemaVersion: 1` attempts by adding `kind: "answered"` and returning a version-2 in-memory history.
3. Rejecting schemas other than 1 or 2.
4. Validating a version-2 attempt by discriminator, rejecting fields that belong to the other variant.

Do not write an upgraded file during `getHistory`; the next normal `commitHistory` persists version 2 atomically.

- [ ] **Step 4: Add activity restoration coverage**

Keep activity snapshots valid while the attempt model changes:

```ts
test("restores an active exam independently of learning-history schema migration", () => {
  expect(() => app.restoreActivity(JSON.stringify(activeExam))).not.toThrow();
});
```

- [ ] **Step 5: Run the focused verification**

Run: `npm test -- test/storage.test.ts test/state-machine.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the atomic data-contract change**

```bash
git add src/domain.ts src/storage.ts test/storage.test.ts test/state-machine.test.ts
git commit -m "feat: model explicit unanswered exam evidence"
```

---

### Task 2: Schedule and report omissions without fabricating calibration data

**Files:**

- Modify: `src/scheduler.ts`
- Modify: `src/dashboard.ts`
- Modify: `test/scheduler.test.ts`
- Modify: `test/application.test.ts`

**Interfaces:**

- Produces `scheduler.applyAttempt(track, attempt, now)` or an equivalent helper that maps an unanswered attempt to `Rating.Again`.
- `trackForAttempt()` returns `"unassisted"` for an unanswered exam attempt.
- `buildDashboard()` excludes attempts with no numeric confidence from mean absolute error and confidence bins.

- [ ] **Step 1: Write scheduler and dashboard failures**

```ts
test("routes an unanswered exam item to the unaided review track", () => {
  expect(trackForAttempt(unansweredAttempt)).toBe("unassisted");
  expect(
    scheduler.applyAttempt(undefined, unansweredAttempt, now)?.reviewHistory[0],
  ).toMatchObject({ rating: "Again" });
});

test("excludes unanswered exam items from confidence calibration", () => {
  const dashboard = buildDashboard(
    course,
    {
      ...history,
      attempts: [answeredCorrectAttempt, unansweredAttempt],
    },
    now,
  );

  expect(
    dashboard.confidenceCalibration.reduce((n, bin) => n + bin.attempts, 0),
  ).toBe(1);
  expect(dashboard.unansweredExamItems).toEqual([
    expect.objectContaining({ questionId: unansweredAttempt.question.id }),
  ]);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- test/scheduler.test.ts test/application.test.ts`

Expected: FAIL because `Attempt` is no longer structurally assumed answered and the dashboard has no omission projection.

- [ ] **Step 3: Implement deterministic omission scheduling**

In `src/scheduler.ts`, branch on `attempt.kind` before using `correctness`:

```ts
export function trackForAttempt(attempt: Attempt): FsrsTrackName | undefined {
  if (attempt.kind === "unanswered") return "unassisted";
  if (
    attempt.correctness === undefined ||
    attempt.correctness === "ungradable"
  ) {
    return undefined;
  }
  return attempt.highestHintLevel > 0 || attempt.revealed
    ? "assisted"
    : "unassisted";
}
```

Map an unanswered attempt to `Rating.Again`. Do not add `"unanswered"` to `Correctness`; it is an attempt outcome, not a model grade.

In `src/dashboard.ts`, restrict calibration to:

```ts
attempt.kind === "answered" &&
  attempt.confidence !== undefined &&
  attempt.correctness !== undefined &&
  attempt.correctness !== "ungradable";
```

Add `unansweredExamItems` to `Dashboard` as `{ questionId, conceptId, omissionReason }[]`, and show it in dashboard text after unresolved misconceptions.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- test/scheduler.test.ts test/application.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit scheduler/reporting behavior**

```bash
git add src/scheduler.ts src/dashboard.ts src/domain.ts test/scheduler.test.ts test/application.test.ts
git commit -m "feat: schedule and report unanswered exam items"
```

---

### Task 3: Persist omitted exam items in the core at submission time

**Files:**

- Modify: `src/application.ts`
- Modify: `test/application.test.ts`

**Interfaces:**

- `submitExam(activity)` records every item absent from `exam.drafts` before returning the submitted activity.
- Manual submissions use `omissionReason: "manual-partial"`; deadline submissions use `"deadline"`.
- `recordExamGrades()` records only answered drafts and cannot duplicate omissions.

- [ ] **Step 1: Write failing submission tests**

```ts
test("records each manually omitted exam item before model grading", async () => {
  const submitted = await app.submitExam(activeExamWithOneOfTwoDrafts);
  const attempts = (await store.getHistory(course.id)).attempts;

  expect(submitted.state).toMatchObject({ tag: "exam-submitted" });
  expect(attempts).toContainEqual(
    expect.objectContaining({
      kind: "unanswered",
      question: { id: "two" },
      omissionReason: "manual-partial",
    }),
  );
});

test("applies only one Again review per concept for multiple omitted items", async () => {
  await app.submitExam(activeExamWithTwoBlankItemsForSameConcept);
  const track = (await store.getHistory(course.id)).concepts.kinematics!
    .unassisted!;
  expect(track.reviewHistory).toHaveLength(1);
  expect(track.reviewHistory[0]).toMatchObject({ rating: "Again" });
});

test("grades only drafts after omissions are recorded", async () => {
  const submitted = await app.submitExam(activeExamWithOneOfTwoDrafts);
  await app.recordExamGrades(submitted, [
    {
      questionId: "one",
      correctness: "correct",
      gradingRationale: "Complete",
    },
  ]);

  expect((await store.getHistory(course.id)).attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "unanswered", question: { id: "two" } }),
      expect.objectContaining({ kind: "answered", question: { id: "one" } }),
    ]),
  );
});
```

- [ ] **Step 2: Run the application test file to verify failure**

Run: `npm test -- test/application.test.ts`

Expected: FAIL because `submitExam()` only transitions activity today.

- [ ] **Step 3: Record blanks atomically in `submitExam`**

Update `TutorApplicationService.submitExam()` to:

1. Validate the active exam and derive `expired` once.
2. Identify `exam.items` not present in `exam.drafts`.
3. Call one `store.commitHistory()` operation that appends an `UnansweredAttempt` per omitted item.
4. Use `exam.submittedAt`/current time as the attempt timestamp.
5. Add omission attempts to history for reporting, but deduplicate FSRS application by `targetConceptId` so only the first omission per concept applies `Again`.
6. Transition to `exam-submitted` only after the history commit succeeds.

Keep `recordExamGrades()` exact-coverage validation against `exam.drafts`; it must not ask the model for grades of omitted items. Update its answered attempt construction with `kind: "answered"`.

- [ ] **Step 4: Add deadline reason coverage**

```ts
test("labels deadline omissions and still grades saved drafts later", async () => {
  clock.set(new Date("2026-08-27T10:01:00.000Z"));
  const submitted = await app.submitExam(timedExamWithMissingDraft);

  expect((await store.getHistory(course.id)).attempts).toContainEqual(
    expect.objectContaining({ omissionReason: "deadline" }),
  );
});
```

- [ ] **Step 5: Run focused verification**

Run: `npm test -- test/application.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the core submission boundary**

```bash
git add src/application.ts test/application.test.ts
git commit -m "feat: record omitted exam items at submission"
```

---

### Task 4: Add a reusable compact response collector

**Files:**

- Create: `src/response-ui.ts`
- Create: `test/response-ui.test.ts`

**Interfaces:**

```ts
export type ResponsePurpose = "graded" | "correction" | "explanation" | "exam";
export type ResponseResult =
  | { kind: "submitted"; answer: string; confidence?: number }
  | { kind: "deferred"; draft: { answer: string; confidence?: number } }
  | { kind: "cancelled" };

export interface ResponseRequest {
  purpose: ResponsePurpose;
  answer?: string;
  confidence?: number;
  requiresConfidence: boolean;
}

export function collectResponse(
  ctx: ExtensionContext,
  request: ResponseRequest,
): Promise<ResponseResult>;
```

- [ ] **Step 1: Write keyboard and fallback tests**

```ts
test("requires an intentional confidence action before confirmation", async () => {
  const panel = createConfidencePanel({ confidence: undefined });
  panel.handleInput("\r");
  expect(panel.result()).toBeUndefined();

  panel.handleInput("\x1b[C"); // right
  expect(panel.value()).toBe(55);
  panel.handleInput("\r");
  expect(panel.result()).toEqual({
    kind: "submitted",
    answer: "x",
    confidence: 55,
  });
});

test("keeps a multiline answer bounded and defers on escape", async () => {
  const result = await collectResponse(tuiContext, {
    purpose: "graded",
    requiresConfidence: true,
    answer: "draft",
  });
  expect(result).toEqual({ kind: "deferred", draft: { answer: "draft" } });
});

test("uses editor then numeric input in RPC mode", async () => {
  rpcUi.editor.mockResolvedValue("answer");
  rpcUi.input.mockResolvedValue("75");
  await expect(collectResponse(rpcContext, gradedRequest)).resolves.toEqual({
    kind: "submitted",
    answer: "answer",
    confidence: 75,
  });
});
```

- [ ] **Step 2: Run the new test file to verify failure**

Run: `npm test -- test/response-ui.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement TUI and RPC collection without persistence**

In TUI mode, build two `ctx.ui.custom()` bottom overlays:

- A bare multiline `Editor` panel with no prompt/source repetition, 5–7 rows, and a short key hint.
- A confidence panel showing `Confidence: 50 / 100` in a visually unconfirmed state until an arrow or digit input occurs. Left/Right adjusts by 5; typed integer input replaces the value; values outside 0–100 display an inline error and cannot continue.

Use `overlay: true` and bottom-centre overlay options so the expanded question card remains readable. `Enter` advances from answer to confidence (or submits a no-confidence correction/explanation); `Shift+Enter` is delegated to the editor; `Escape` returns `{ kind: "deferred" }` with the in-memory draft.

In RPC mode, call `ctx.ui.editor("Your answer", prefill)` and then `ctx.ui.input("Confidence (0–100)")` only when confidence is required. In no-UI mode, return `cancelled`; the adapter retains parser fallback rather than trying to render a panel.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- test/response-ui.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the focused collector**

```bash
git add src/response-ui.ts test/response-ui.test.ts
git commit -m "feat: add compact tutor response collector"
```

---

### Task 5: Replace interactive header parsing with a state-driven response controller

**Files:**

- Modify: `extensions/exam-tutor/index.ts`
- Modify: `src/application.ts`
- Modify: `src/ui.ts`
- Modify: `test/application.test.ts`
- Modify: `test/extension.test.ts`

**Interfaces:**

- Register `/resume-answer`.
- Register custom message renderers for `pi-exam-tutor/learner-response-v1` and `pi-exam-tutor/exam-item-v1`.
- Maintain ephemeral controller state:

```ts
interface PendingResponse {
  purpose: ResponsePurpose;
  activityFingerprint: string;
  draft: { answer: string; confidence?: number };
}

interface ResponseControllerState {
  panelOpen: boolean;
  deferred?: PendingResponse;
}
```

- [ ] **Step 1: Write adapter lifecycle failures**

```ts
test("opens one response panel after the tutor turn settles", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  extension(fake.api, createDependencies());
  await fake.startSession();

  await fake.agentSettled();
  await fake.agentSettled();

  expect(fake.ui.custom).toHaveBeenCalledTimes(1);
});

test("persists and sends a confirmed answer as a custom learner message", async () => {
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "Velocity changes.",
    confidence: 70,
  });
  await fake.agentSettled();

  expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
    answer: "Velocity changes.",
    confidence: 70,
  });
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        customType: "pi-exam-tutor/learner-response-v1",
        content: expect.stringContaining("<exam-tutor-learner-submission>"),
        display: true,
      }),
      options: { triggerTurn: true },
    }),
  );
});

test("defers without persistence and restores ordinary typed text", async () => {
  fake.ui.custom.mockResolvedValueOnce({
    kind: "deferred",
    draft: { answer: "x" },
  });
  await fake.agentSettled();

  await expect(fake.dispatchInput("do not lose this")).resolves.toEqual({
    action: "handled",
  });
  expect(fake.ui.setEditorText).toHaveBeenCalledWith("do not lose this");
  expect(fake.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("/resume-answer"),
    "info",
  );
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test -- test/extension.test.ts`

Expected: FAIL because no settled-event response controller or custom learner message exists.

- [ ] **Step 3: Implement the controller and custom card renderers**

In `extensions/exam-tutor/index.ts`:

1. Add an `agent_settled` handler. If activity is `awaiting-primary-answer`, `awaiting-correction`, or `awaiting-explanation`, no response panel is open, and no deferred response is active, call `collectResponse()`.
2. Build an activity fingerprint from state tag, question ID, attempt ID, and hint level; this one-flight guard prevents duplicate overlays for repeated settled events.
3. Update `submissionDetails()` to return `requiresConfidence: boolean` and make `assertSubmission(submission, requiresConfidence)` reject a missing confidence only for primary/transfer attempts. On `submitted`, call the appropriate application method and `persist()` **before** `pi.sendMessage()` triggers the model turn. For correction, record `{ answer }`; for explanation, call the explanation path. Add an application test that a correction persists an answered attempt without `confidence` and no calibration-ready grade.
4. Use `pi.sendMessage()` with a canonical `<exam-tutor-learner-submission>` or `<exam-tutor-learner-explanation>` content payload, `display: true`, `triggerTurn: true`, and structured display details. Do not return an input transform for interactive panel submissions.
5. On `deferred`, store only the ephemeral draft and call `updateTutorStatus()`/a new `setDeferredResponseWidget()` helper. Clear this state on session shutdown and session start.
6. Register `/resume-answer`; it reopens the panel only for a matching current awaiting-response state and otherwise notifies that no response is pending.
7. When deferred normal input arrives, call `ctx.ui.setEditorText(event.text)`, show the resume notice, and return `{ action: "handled" }`. Retain header parsing only when `ctx.hasUI === false`.
8. Register `pi.registerMessageRenderer("pi-exam-tutor/learner-response-v1", ...)`. With `expanded === false`, render one concise line such as `Your answer · confidence 70`; with `expanded === true`, render answer, confidence, and mode. Use the standard renderer `expanded` option; do not add a competing `Ctrl+O` shortcut.

In `src/ui.ts`, keep the existing tutor status but render a single deferred line above the editor: `Response deferred · /resume-answer`.

- [ ] **Step 4: Add correction-specific coverage**

```ts
test("collects a correction without confidence", async () => {
  const correction = {
    ...awaitingAnswer,
    state: {
      tag: "awaiting-correction",
      courseId: course.id,
      mode: "study",
      attemptId: "attempt-1",
      question,
      hintLevel: 0,
    },
  } satisfies SessionActivity;

  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "Corrected answer.",
  });
  await fake.agentSettled();

  expect(acceptSubmission).toHaveBeenCalledWith(correction, {
    answer: "Corrected answer.",
  });
});
```

- [ ] **Step 5: Run focused verification**

Run: `npm test -- test/extension.test.ts test/response-ui.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the regular-response controller**

```bash
git add extensions/exam-tutor/index.ts src/ui.ts test/extension.test.ts
git commit -m "feat: collect tutor responses through compact panels"
```

---

### Task 6: Add exam navigation, pending edits, review, and citation-safe cards

**Files:**

- Modify: `extensions/exam-tutor/index.ts`
- Modify: `test/extension.test.ts`

**Interfaces:**

```ts
interface ExamControllerState {
  activeQuestionId?: string;
  pendingEdit?: {
    questionId: string;
    answer: string;
    previousConfidence: number;
  };
}
```

- [ ] **Step 1: Write failing exam interaction tests**

```ts
test("renders only the active exam item without a source locator", async () => {
  await fake.executeTool("tutor_present_exam", { items: twoExamItems });
  await fake.agentSettled();

  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        customType: "pi-exam-tutor/exam-item-v1",
        content: expect.stringContaining("Explain acceleration."),
      }),
    }),
  );
  expect(fake.sentMessages.flatMap(messageText)).not.toContain(
    "/courses/physics/notes.md",
  );
});

test("saves an exam answer only after confidence and advances to the next item", async () => {
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "First",
    confidence: 80,
  });
  await fake.agentSettled();

  expect(fake.appendedEntries.at(-1)).toMatchObject({
    data: {
      state: { exam: { drafts: { "1": { answer: "First", confidence: 80 } } } },
    },
  });
  expect(activeExamCardText(fake)).toContain("second prompt");
});

test("does not overwrite a saved exam draft before reconfirmed confidence", async () => {
  // Open edit for a draft with confidence 80, then defer after changing answer.
  await fake.invokeCommand("exam", "edit 1");
  fake.ui.custom.mockResolvedValueOnce({
    kind: "deferred",
    draft: { answer: "changed", confidence: 80 },
  });
  await fake.agentSettled();

  expect(lastPersistedDraft(fake, "1")).toMatchObject({
    answer: "original",
    confidence: 80,
  });
  await expect(fake.invokeCommand("exam", "submit")).resolves.toBeUndefined();
  expect(fake.ui.select).toHaveBeenCalledWith(
    expect.stringContaining("pending edit"),
    expect.arrayContaining(["resume", "discard"]),
  );
});

test("shows review before manually submitting a partial exam", async () => {
  await fake.invokeCommand("exam", "submit");
  expect(fake.ui.custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.anything(),
  );
  expect(reviewText(fake)).toContain("Unanswered");
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test -- test/extension.test.ts`

Expected: FAIL because the adapter still displays every cited prompt together and parses bulk text drafts.

- [ ] **Step 3: Implement the per-item exam controller**

Replace the TUI path that calls `parseExamDraft()` for active exams with controller behavior:

1. `tutor_present_exam` persists the full `ExamSession` but returns only an `Exam ready` result; it must not render full prompts or citations.
2. Choose the first unanswered item as `activeQuestionId`; append a displayable `pi-exam-tutor/exam-item-v1` message containing the prompt and progress only. Its renderer is always expanded. Never include `sourceRefs` in content or details.
3. Collect the active item through `collectResponse({ purpose: "exam", requiresConfidence: true })` after the turn settles. On confirmed response, update that one draft with `examDraftAccepted`, persist, then append the next unanswered item card. If all items have drafts, append a compact `Review & Submit` readiness card instead.
4. Provide an explicit per-item edit action in the review UI. Edit answer and confidence as separate controls. Editing an answer opens the confidence step with the old numeric value prefilled; it is not committed until the learner explicitly confirms it.
5. Store a deferred changed draft as `pendingEdit`; do not replace the previously persisted pair. Manual `/exam submit` first forces a Resume/Discard choice for any pending edit.
6. Show a review overlay before **every** manual submit. List each question as `answered`, `confidence reconfirmation pending`, or `unanswered`; permit partial confirmation. Only after the learner confirms review call `app.submitExam()` and trigger aggregate grading.
7. Keep the deadline timer noninteractive. It calls `app.submitExam()` against only persisted drafts and then triggers aggregate grading.
8. In non-TUI mode, retain `parseExamDraft()` as the no-UI fallback; update its documentation wording but keep the parser locally enforced.

- [ ] **Step 4: Restore citations only after grading**

Update aggregate grade display so every grade output is paired with the stored submitted question’s source references. Do not change `aggregateExamSubmission()` source material context for the model; that information remains needed for grading but is not shown in active exam cards.

```ts
test("shows stored source citations only in post-grade exam feedback", async () => {
  const result = await fake.executeTool("tutor_record_exam_grades", {
    grades: [examGrade],
  });
  expect(result.details.display).toContain("/courses/physics/notes.md");
});
```

- [ ] **Step 5: Run focused verification**

Run: `npm test -- test/extension.test.ts test/application.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the exam interaction boundary**

```bash
git add extensions/exam-tutor/index.ts test/extension.test.ts
git commit -m "feat: guide exam answers through per-item review"
```

---

### Task 7: Update parser contracts, documentation, and full verification

**Files:**

- Modify: `src/input.ts`
- Modify: `test/input.test.ts`
- Modify: `README.md`
- Modify: `skills/exam-tutor/SKILL.md`
- Modify: `skills/exam-tutor/references/protocol.md`

**Interfaces:**

- `parseAnswer()` and `parseExamDraft()` remain available exclusively for no-UI fallback.
- README describes interactive response flow first, then a clearly labelled no-UI fallback grammar.

- [ ] **Step 1: Add explicit fallback tests**

```ts
test("documents header parsing as a no-UI fallback rather than the interactive protocol", async () => {
  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain("Interactive response flow");
  expect(readme).toContain("No-UI fallback syntax");
  expect(readme).toContain("/resume-answer");
});

test("continues to reject malformed fallback confidence headers", () => {
  expect(parseAnswer("not a header")).toMatchObject({
    message: expect.any(String),
  });
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run: `npm test -- test/input.test.ts test/extension.test.ts`

Expected: FAIL because documentation still calls header syntax the primary answer interface.

- [ ] **Step 3: Update user-facing protocol documentation**

Update `README.md` to include:

- Interactive normal/transfer answer flow: expanded question, compact multiline response panel, separate confidence picker, deferred response and `/resume-answer`.
- Correction flow without confidence.
- Exam item flow: active prompt only, Save & Next, separate edit actions, review before manual partial submit, deadline behavior, and omitted-item reporting/scheduling.
- Citation policy: question citations in study/drill/review; exam citations hidden until grading; hiding does not mechanically prevent external/open-book assistance.
- No-UI fallback grammar, including the legacy confidence headers and multi-item exam draft format.
- Migration note: existing version-1 histories upgrade in memory and persist as version 2 on their next mutation.

Update the reusable skill/reference so it does not instruct an interactive learner to type `[confidence: N]`, describes the answer/confidence two-step requirement, and preserves the model’s canonical-tool obligation.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run format
npm run format:check
npm run typecheck
npm test
git diff --check
```

Expected: every command exits 0; no whitespace errors.

- [ ] **Step 5: Commit documentation and verification changes**

```bash
git add README.md skills/exam-tutor/SKILL.md skills/exam-tutor/references/protocol.md src/input.ts test/input.test.ts
git commit -m "docs: describe compact tutor response flow"
```

---

## Requirements Coverage Review

- Atomic answer/confidence commitment, deferred drafts, compact multiline panel, confidence input, and response card behavior: Tasks 4–5.
- No-confidence correction path: Tasks 1, 4, and 5.
- Active exam cards, Save & Next, edit/reconfirmation, review-before-submit, and deadline behavior: Task 6.
- Explicit unanswered results, omission reasons, calibration exclusion, and one-per-concept FSRS scheduling: Tasks 1–3.
- Citation suppression during active exam and post-grade citation display: Task 6.
- RPC and no-UI behavior plus removal of interactive header-syntax guidance: Tasks 4, 5, and 7.
- Legacy learning-history compatibility and existing protocol preservation: Tasks 1 and 7.
- Automated tests, typechecking, formatting, and diff hygiene: every task and Task 7.

## Self-Review

- **Spec coverage:** All user-decided interaction rules and the oracle’s blocker/high findings map to a task. The plan deliberately does not add a runtime dependency on the Ask User Questions package.
- **Placeholder scan:** No task delegates a behavior to an unspecified future implementation; every behavioral boundary names the responsible file, public/internal interface, test case, and verification command.
- **Type consistency:** Unanswered evidence is represented by an `Attempt` discriminator throughout storage, scheduling, dashboard, and application layers. Only `AnsweredAttempt` may have answer text; only calibrated answered evidence has numeric confidence.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-29-tutor-question-interface.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.
