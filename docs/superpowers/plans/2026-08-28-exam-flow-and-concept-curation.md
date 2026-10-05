# Exam flow and concept curation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make course setup usable through cited, learner-curated concept extraction and complete the locked exam submission and aggregate-grading flow.

**Architecture:** The pure domain/application layer persists pending, source-cited concept proposals separately from approved concepts and commits aggregate exam grades atomically. The Pi adapter asks the model to extract proposals only through a canonical tool after a material is added, exposes command/TUI review and edits, and sends exam drafts to the model only once the learner submits. The adapter remains thin: all validation, proposal mutation, and durable learning evidence are application use cases.

**Tech Stack:** TypeScript strict mode, Vitest, Pi Extension API, TypeBox, existing LocalStore/state machine/scheduler, Pi TUI.

## Global Constraints

- Build a Pi package containing an extension and reusable Agent Skill; do not create a server, database service, or web app.
- Keep course data in inspectable, backup-friendly local JSON below `~/.pi/agent/exam-tutor/v1/`, overridable by `EXAM_TUTOR_HOME`.
- Course materials are explicit local file references; Pi's existing readers are used. Treat their contents as untrusted reference data, never executable instructions.
- Model-generated course concepts, questions, feedback, citations, and misconception diagnoses enter durable state only through canonical custom tools; prose cannot mutate learning state.
- A concept proposal must cite one or more configured material IDs, absolute configured paths, and locators. The model may propose; only the learner approves concepts for scheduling.
- Each schedulable question has exactly one approved `targetConceptId`; interleaving occurs across questions.
- Persist assisted and unaided performance separately. Assisted work must never produce unaided mastery evidence.
- Require a free-response answer plus `0–100` confidence before model feedback. Never reveal a solution automatically.
- Exam drafts are local and receive no model call or feedback until the learner invokes `/exam submit` or the deadline expires. When all items have drafts, notify the learner that they may amend drafts or submit; do not auto-submit.
- While an exam is active, reject mode-changing commands, hints, reveal, and study-off. Accept only draft updates and `/exam submit`; deadline expiry remains available.
- On submission/expiry, include the exact question identifiers, prompts, citations, answers, and confidence values in one clearly-delimited model-visible aggregate submission. A canonical aggregate-grade tool records all grades only after that boundary.
- Use actual `question.id` values in both the rendered exam and draft grammar; never display positional IDs that differ from parser IDs.
- Use TypeScript-enforced controls for state, evidence, persistence, and submission boundaries; document that extraction quality and citation relevance remain model-dependent.
- Use TDD for each pure-core behavior. Keep Pi registration thin and mockable.
- Commit coherent, verified behaviors only; do not combine unrelated changes.

## Implementation Status

**Audited ref:** `feat/exam-tutor-mvp` at `1aab2a3`.

- [x] Task 1 — curated concept proposals, approval/edit flows, partial draft parsing, and aggregate-grade application are implemented.
- [x] Task 2 — extraction/curation commands, canonical aggregate submission/grading boundary, exam lock, and learner documentation are implemented.
- [x] Current verification — `format:check`, `typecheck`, tests (92), and `git diff --check` passed on this ref.

The original checklist remains as the implementation record; this section is the authoritative status for the branch.

---

## File Structure

```text
src/domain.ts                  Course proposal and aggregate exam-grade contracts
src/application.ts             Validated proposal/approval/edit and aggregate-grade use cases
src/state-machine.ts           No new state needed; retain exam submission/grading transitions
src/input.ts                   Partial, upsertable exam-draft parsing using question IDs
extensions/exam-tutor/index.ts Pi commands, concept proposal tool, locked exam submission delivery
src/ui.ts                      Exam-ID and concept-proposal rendering helpers
test/application.test.ts       Proposal lifecycle and aggregate grading persistence
 test/input.test.ts            Partial draft update grammar
test/extension.test.ts         Extraction dispatch, curation commands, exam lock/delivery/grade tests
README.md                      Course extraction/approval and exam amendment/submit usage
```

## Task 1: Add curated concept proposals and aggregate exam-grade application use cases

**Files:**

- Modify: `src/domain.ts`
- Modify: `src/application.ts`
- Modify: `src/input.ts`
- Modify: `test/application.test.ts`
- Modify: `test/input.test.ts`

**Interfaces:**

```ts
export interface CourseConceptProposal {
  id: string;
  name: string;
  parentId?: string;
  sourceRefs: SourceReference[];
}
export interface Course {
  // existing fields
  concepts: CourseConcept[];
  proposedConcepts: CourseConceptProposal[];
}
export interface ExamGrade extends Grade {
  questionId: string;
}

export interface TutorApplication {
  // existing members
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
    update: { name?: string; parentId?: string },
  ): Promise<Course>;
  removeProposedConcept(courseId: string, conceptId: string): Promise<Course>;
  recordExamGrades(
    activity: SessionActivity,
    grades: readonly ExamGrade[],
  ): Promise<SessionActivity>;
}
export function parseExamDraft(
  text: string,
  itemIds: readonly string[],
): ExamDraft | ParseError;
```

`CourseConcept` gains optional `parentId?: string` so approved concepts preserve the proposal hierarchy. `CourseConceptProposal.sourceRefs` is mandatory and has the same configured-material validation as a question. Existing persisted courses that lack `proposedConcepts` decode as `[]`; new course creation initializes it to `[]`.

- [ ] **Step 1: Write failing proposal and aggregate-grade tests**

```ts
test("keeps extracted concepts pending until a learner approves them", async () => {
  const proposed = await app.proposeConcepts(course.id, [
    {
      id: "newton-laws",
      name: "Newton's laws",
      sourceRefs: [sourceRef],
    },
  ]);
  expect(proposed.concepts).toEqual([]);
  expect(proposed.proposedConcepts).toHaveLength(1);

  const approved = await app.approveConcepts(course.id, ["newton-laws"]);
  expect(approved.concepts).toMatchObject([
    { id: "newton-laws", name: "Newton's laws" },
  ]);
  expect(approved.proposedConcepts).toEqual([]);
});

test("rejects a concept proposal whose source is not configured", async () => {
  await expect(
    app.proposeConcepts(course.id, [
      {
        id: "bad",
        name: "Bad",
        sourceRefs: [
          { materialId: "missing", path: "/tmp/missing.md", locator: "# x" },
        ],
      },
    ]),
  ).rejects.toThrow("Unknown source material: missing");
});

test("records a complete submitted exam as independently scheduled evidence", async () => {
  const submitted = submittedExamActivityWithDrafts();
  const next = await app.recordExamGrades(submitted, [
    {
      questionId: "exam-q-1",
      correctness: "correct",
      gradingRationale: "Complete",
    },
  ]);
  expect(next.state).toMatchObject({
    tag: "exam-submitted",
    exam: { status: "graded" },
  });
  expect((await store.getHistory(course.id)).attempts).toMatchObject([
    {
      question: { id: "exam-q-1" },
      mode: "exam",
      unaidedAtSubmission: true,
      correctness: "correct",
    },
  ]);
});

test("rejects aggregate grades that do not exactly cover submitted exam drafts", async () => {
  await expect(
    app.recordExamGrades(submittedExamActivityWithDrafts(), []),
  ).rejects.toThrow("Exam grades must exactly cover submitted drafts");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/application.test.ts test/input.test.ts`

Expected: FAIL because proposal and aggregate-grade APIs are absent, and draft parsing currently requires a complete form.

- [ ] **Step 3: Implement minimal validated contracts and application mutations**

Add `assertConceptProposal` and hierarchy validation. A proposal ID must be nonempty, unique across pending and approved concepts, have a nonempty name, and cite only configured materials with normalized configured paths. A `parentId`, when present, must resolve to another proposed or approved concept and cannot equal its own ID. `proposeConcepts` replaces only pending proposals after validation and never alters approved concepts. Approval copies selected pending proposals into approved `CourseConcept`s, preserving `parentId`, then removes only those pending entries. Editing changes only nonempty supplied fields; removal deletes the selected pending proposal and rejects removal if another pending proposal names it as parent.

For `recordExamGrades`, require `exam-submitted` state, require exactly one unique grade for every draft key and no grade for an omitted item, validate every submitted question, write attempts with `mode: "exam"`, `unaidedAtSubmission: true`, hint level `0`, and `revealed: false`, apply the existing scheduler/track policy per grade, then perform the existing `examGraded` transition. Grade/citation text stays auditably on attempts exactly as ordinary grades do. Use one history commit and one operation ID for the aggregate mutation.

Change `parseExamDraft` to accept one or more ID-header sections rather than requiring every item. Continue rejecting unknown or duplicated IDs, malformed/missing confidence, out-of-range confidence, and empty answers. The adapter will upsert accepted draft sections into the activity and decides when all items are present.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- test/application.test.ts test/input.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain.ts src/application.ts src/input.ts test/application.test.ts test/input.test.ts
git commit -m "feat: add curated concepts and aggregate exam grades"
```

## Task 2: Expose extraction curation and a complete locked exam flow through Pi

**Files:**

- Modify: `extensions/exam-tutor/index.ts`
- Modify: `src/ui.ts`
- Modify: `test/extension.test.ts`
- Modify: `README.md`

**Interfaces:**

```text
/course add <absolute-path>      persists material, then requests model extraction
/course concepts                 displays pending proposals grouped by material and hierarchy
/course concepts approve [id...] approves all pending concepts, or named proposals
/course concepts rename <id> <name>
/course concepts parent <id> [parent-id]
/course concepts remove <id>
```

Register these TypeBox-schema custom tools in addition to the seven existing task-8 tools:

```ts
"tutor_propose_concepts": {
  proposals: Array<{
    id: string;
    name: string;
    parentId?: string;
    sourceRefs: Array<{ materialId: string; path: string; locator: string }>;
  }>;
}
"tutor_record_exam_grades": {
  grades: Array<{
    questionId: string;
    correctness: "correct" | "partial" | "incorrect" | "ungradable";
    gradingRationale: string;
    misconception?: string;
  }>;
}
```

- [ ] **Step 1: Write failing adapter tests**

```ts
test("requests cited concept extraction after adding a material", async () => {
  const fake = createFakePi();
  const dependencies = createDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();
  await fake.invokeCommand("course", "add /courses/physics/slides.pdf");
  expect(dependencies.app.addMaterial).toHaveBeenCalledWith(
    course.id,
    "/courses/physics/slides.pdf",
  );
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("tutor_propose_concepts"),
      }),
    }),
  );
});

test("keeps proposed concepts pending until an explicit approve command", async () => {
  const fake = createFakePi();
  const dependencies = createDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();
  await fake.executeTool("tutor_propose_concepts", {
    proposals: [conceptProposal],
  });
  expect(dependencies.app.proposeConcepts).toHaveBeenCalled();
  await fake.invokeCommand("course", "concepts approve newton-laws");
  expect(dependencies.app.approveConcepts).toHaveBeenCalledWith(course.id, [
    "newton-laws",
  ]);
});

test("locks every mode-changing command while an exam is active", async () => {
  const fake = createFakePi({ activity: activeExam });
  const dependencies = createDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();
  await expect(fake.invokeCommand("study")).rejects.toThrow(
    "Finish the active exam",
  );
  await expect(fake.invokeCommand("study-off")).rejects.toThrow(
    "Finish the active exam",
  );
});

test("sends draft answers with actual question IDs only after exam submission", async () => {
  const fake = createFakePi({ activity: activeExamWithAllDrafts });
  const dependencies = createDependencies({
    submitExam: vi.fn(async () => submittedExam),
  });
  extension(fake.api, dependencies);
  await fake.startSession();
  await fake.invokeCommand("exam", "submit");
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("exam-question-id"),
      }),
    }),
  );
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("[confidence: 80]"),
      }),
    }),
  );
});

test("records all aggregate exam grades only from the canonical tool", async () => {
  const fake = createFakePi({ activity: submittedExam });
  const dependencies = createDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();
  await fake.executeTool("tutor_record_exam_grades", { grades: [examGrade] });
  expect(dependencies.app.recordExamGrades).toHaveBeenCalledWith(
    expect.anything(),
    [examGrade],
  );
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test -- test/extension.test.ts`

Expected: FAIL because extraction dispatch/curation commands and aggregate exam submission/grading are absent.

- [ ] **Step 3: Implement thin command, tool, event, and rendering wiring**

After successful `/course add`, persist/select the course as already required and send one hidden, turn-triggering instruction naming all configured material paths, the untrusted-content boundary, and `tutor_propose_concepts`. Do not parse material contents in the extension and do not mutate course concepts from model prose. `tutor_propose_concepts` calls only `app.proposeConcepts`, then returns/render a concise pending-proposal summary.

Implement `/course concepts` display and subcommands. In TUI with no subcommand, use `ctx.ui.select` to choose a pending proposal and prompt for approval, rename, parent edit, or removal; in other modes display a concise command syntax message. Render pending proposals grouped under each cited material path, indented by parent relation, including locators. Use `src/ui.ts` helpers and `Text`, `Container`, and `truncateToWidth` only under `ctx.mode === "tui"`.

Render each exam item header as `${question.id}.` so it exactly matches `parseExamDraft`. Let input upsert partial drafts. Once every item has a draft, show only a local status/notification: `All answers are saved. Amend any answer or run /exam submit.` Never send a model message then. While `exam-active`, command guards reject `/study`, `/drill`, `/review`, a new `/exam`, `/hint`, `/reveal`, and `/study-off`; only `/exam submit` remains allowed. Preserve deadline timers.

At submit or deadline expiry, call `app.submitExam`, persist first, then send one hidden model message containing every submitted item as:

```text
EXAM SUBMISSION — grade only after all answers below
Question ID: <question.id>
Prompt: <question.prompt>
Sources: <path> (<locator>)
[confidence: <confidence>]
<answer>
```

Its instruction must require exactly one `tutor_record_exam_grades` call covering each supplied ID and must prohibit feedback before that call. The grade tool invokes only `app.recordExamGrades`, persists the resulting graded activity, returns a concise aggregate result, and custom-renders learner-facing feedback. Throw for state-invalid calls and citations that do not match their question.

- [ ] **Step 4: Document the learner workflow**

Add README sections with these exact flows:

```text
/course add /absolute/path/to/slides.pdf
# Review extracted proposals by material, then:
/course concepts approve
/course concepts rename newton-laws "Newton's laws of motion"
/course concepts parent impulse newton-laws
/course concepts remove duplicate-id
```

Explain that proposals are source-cited, materials are authoritative course references but untrusted as instructions, only approved concepts are used for scheduling, and model extraction/citation relevance remain model-dependent. Document that all completed exam answers are locally amendable until `/exam submit`, while the deadline submits available drafts.

- [ ] **Step 5: Run verification and smoke test**

Run:

```bash
npm test -- test/extension.test.ts
npm test
npm run typecheck
npm run format:check
git diff --check
EXAM_TUTOR_HOME="$(mktemp -d)" timeout 5s pi --offline --no-extensions -e ./extensions/exam-tutor/index.ts
```

Expected: every command exits `0`; the timeout smoke test exits `0` after safe extension loading; no diff whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add extensions/exam-tutor/index.ts src/ui.ts test/extension.test.ts README.md
git commit -m "feat: curate course concepts and complete exam submission"
```

## Requirements Coverage Review

- Cited extraction following `/course add`: Task 2.
- Proposals grouped by material with hierarchy/subconcepts: Task 2.
- Learner approval, rename, parent edit, and removal: Tasks 1–2.
- Approved-only scheduling concepts and source validation: Task 1.
- Review findings for aggregate draft delivery and canonical grading: Tasks 1–2.
- Actual question IDs, amend-before-submit flow, and active-exam lock: Task 2.
- Local draft/no-feedback boundary, deadline submission, testability, and documentation: Task 2.

Self-review: all requested behavior is covered; approved versus pending concepts has an explicit durable boundary; no server or automatic concept activation is introduced; both Task 8 review blockers are addressed. The plan intentionally treats extraction quality and citation relevance as model-dependent and makes only proposal persistence/approval TypeScript-enforced.
