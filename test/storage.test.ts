import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SequenceIds, tempRoot } from "./helpers.js";
import {
  LocalStore,
  RevisionConflictError,
  type Store,
} from "../src/storage.js";

async function createStore(): Promise<{
  root: string;
  ids: SequenceIds;
  store: Store;
}> {
  const root = await tempRoot();
  const ids = new SequenceIds();
  return { root, ids, store: new LocalStore(root, ids) };
}

test("migrates a version-1 answered attempt without changing its evidence", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  const history = await store.getHistory(course.id);
  const question = {
    id: "question-1",
    kind: "primary" as const,
    targetConceptId: "concept-1",
    prompt: "Question?",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/notes.md",
        locator: "# question",
      },
    ],
  };
  const attempt = {
    id: "attempt-1",
    operationId: "op-attempt",
    question,
    mode: "study" as const,
    submittedAt: "2026-08-27T09:00:00.000Z",
    unaidedAtSubmission: true,
    highestHintLevel: 0 as const,
    revealed: false,
  };
  const learningPath = join(root, "courses", course.id, "learning.json");

  await writeFile(
    learningPath,
    JSON.stringify({
      ...history,
      schemaVersion: 1,
      attempts: [{ ...attempt, answer: "x", confidence: 70 }],
    }),
  );

  const migrated = await store.getHistory(course.id);
  expect(migrated).toMatchObject({
    schemaVersion: 2,
    attempts: [{ kind: "answered", answer: "x", confidence: 70 }],
  });
  expect(JSON.parse(await readFile(learningPath, "utf8"))).toMatchObject({
    schemaVersion: 1,
  });

  await store.commitHistory(
    course.id,
    migrated.revision,
    "op-migrate",
    (value) => ({ ...value, revision: value.revision + 1 }),
  );
  expect(JSON.parse(await readFile(learningPath, "utf8"))).toMatchObject({
    schemaVersion: 2,
    attempts: [{ kind: "answered", answer: "x", confidence: 70 }],
  });
});

test("accepts an unanswered attempt without an answer or confidence", async () => {
  const { store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  const question = {
    id: "question-1",
    kind: "exam" as const,
    targetConceptId: "concept-1",
    prompt: "Question?",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/notes.md",
        locator: "# question",
      },
    ],
  };

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
          kind: "unanswered" as const,
          question,
          mode: "exam" as const,
          submittedAt: "2026-08-27T09:00:00.000Z",
          unaidedAtSubmission: true,
          highestHintLevel: 0 as const,
          revealed: false,
          omissionReason: "manual-partial" as const,
        },
      ],
    }),
  );

  expect(saved.attempts[0]).toMatchObject({ kind: "unanswered" });
});

test("rejects an unanswered attempt that carries confidence", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  await writeFile(
    join(root, "courses", course.id, "learning.json"),
    JSON.stringify({
      ...(await store.getHistory(course.id)),
      attempts: [
        {
          id: "attempt-blank",
          operationId: "op-blank",
          kind: "unanswered",
          question: {
            id: "question-1",
            kind: "exam",
            targetConceptId: "concept-1",
            prompt: "Question?",
            sourceRefs: [],
          },
          mode: "exam",
          submittedAt: "2026-08-27T09:00:00.000Z",
          confidence: 0,
          unaidedAtSubmission: true,
          highestHintLevel: 0,
          revealed: false,
          omissionReason: "manual-partial",
        },
      ],
    }),
  );

  await expect(store.getHistory(course.id)).rejects.toThrow(
    "Invalid learning history",
  );
});

test("persists course history across fresh store instances", async () => {
  const { root, ids, store: first } = await createStore();
  const course = await first.createCourse("Biology", "op-create");

  expect(course.partialAnswerPolicy).toBe("remediate");
  expect(
    (await new LocalStore(root, ids).getCourse(course.id)).partialAnswerPolicy,
  ).toBe("remediate");

  await first.commitHistory(course.id, 0, "op-history", (history) => ({
    ...history,
    revision: history.revision + 1,
  }));

  const second = new LocalStore(root, ids);
  expect((await second.getHistory(course.id)).revision).toBe(1);
});

test("round-trips independent assisted and unassisted tracks", async () => {
  const { root, ids, store: first } = await createStore();
  const course = await first.createCourse("A", "op-create");

  await first.commitHistory(course.id, 0, "op-tracks", (history) => ({
    ...history,
    revision: 1,
    concepts: {
      "concept-1": {
        unassisted: {
          card: { due: "2026-08-28" },
          reviewHistory: [
            {
              reviewedAt: "2026-08-27T00:00:00.000Z",
              rating: "Good",
              log: { elapsedDays: 1 },
            },
          ],
        },
        assisted: {
          card: { due: "2026-08-29" },
          reviewHistory: [
            {
              reviewedAt: "2026-08-27T01:00:00.000Z",
              rating: "Again",
              log: { elapsedDays: 0 },
            },
          ],
        },
        misconceptions: [],
      },
    },
  }));

  const history = await new LocalStore(root, ids).getHistory(course.id);
  expect(history.concepts["concept-1"]?.unassisted).toEqual({
    card: { due: "2026-08-28" },
    reviewHistory: [
      {
        reviewedAt: "2026-08-27T00:00:00.000Z",
        rating: "Good",
        log: { elapsedDays: 1 },
      },
    ],
  });
  expect(history.concepts["concept-1"]?.assisted).toEqual({
    card: { due: "2026-08-29" },
    reviewHistory: [
      {
        reviewedAt: "2026-08-27T01:00:00.000Z",
        rating: "Again",
        log: { elapsedDays: 0 },
      },
    ],
  });
});

test("keeps courses isolated", async () => {
  const { store } = await createStore();
  const a = await store.createCourse("A", "op-a");
  const b = await store.createCourse("B", "op-b");

  expect((await store.getHistory(a.id)).courseId).toBe(a.id);
  expect((await store.getHistory(b.id)).attempts).toEqual([]);
});

test("replays an operation id without duplicating a course", async () => {
  const { store } = await createStore();
  const once = await store.createCourse("A", "op-a");
  const twice = await store.createCourse("A", "op-a");

  expect(twice.id).toBe(once.id);
  expect(await store.listCourses()).toHaveLength(1);
});

test("replays a history operation without calling the mutator twice", async () => {
  const { store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  let mutationCount = 0;

  const mutate = (history: Awaited<ReturnType<typeof store.getHistory>>) => {
    mutationCount += 1;
    return { ...history, revision: history.revision + 1 };
  };

  await store.commitHistory(course.id, 0, "op-history", mutate);
  const replayed = await store.commitHistory(
    course.id,
    0,
    "op-history",
    mutate,
  );

  expect(mutationCount).toBe(1);
  expect(replayed.revision).toBe(1);
});

test("rejects a stale history revision", async () => {
  const { store } = await createStore();
  const course = await store.createCourse("A", "op-create");

  await expect(
    store.commitHistory(course.id, 99, "op-stale", (history) => history),
  ).rejects.toThrow(RevisionConflictError);
});

test("ignores an uncommitted generated course directory", async () => {
  const { root, store } = await createStore();
  await mkdir(join(root, "courses", "course-1"), { recursive: true });

  const course = await store.createCourse("A", "op-create");

  expect(course.id).toBe("course-2");
  expect(await store.listCourses()).toEqual([course]);
});

test("rejects corrupt persisted JSON", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  await writeFile(
    join(root, "courses", course.id, "learning.json"),
    "not json",
  );

  await expect(store.getHistory(course.id)).rejects.toThrow(
    "Invalid learning history",
  );
});

test("defaults a legacy persisted course without a partial-answer policy", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  const legacyCourse: Record<string, unknown> = { ...course };
  delete legacyCourse.partialAnswerPolicy;
  await writeFile(
    join(root, "courses", course.id, "course.json"),
    JSON.stringify(legacyCourse),
  );

  await expect(store.getCourse(course.id)).resolves.toMatchObject({
    id: course.id,
    partialAnswerPolicy: "remediate",
  });
});

test("defaults only absent proposed concepts and rejects malformed proposals", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  const coursePath = join(root, "courses", course.id, "course.json");
  const legacyCourse: Record<string, unknown> = { ...course };
  delete legacyCourse.proposedConcepts;
  await writeFile(coursePath, JSON.stringify(legacyCourse));

  await expect(store.getCourse(course.id)).resolves.toMatchObject({
    proposedConcepts: [],
  });

  await writeFile(
    coursePath,
    JSON.stringify({ ...course, proposedConcepts: { invalid: true } }),
  );
  await expect(store.getCourse(course.id)).rejects.toThrow("Invalid course");
});

test("rejects persisted proposals with empty IDs", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  await writeFile(
    join(root, "courses", course.id, "course.json"),
    JSON.stringify({
      ...course,
      materials: [
        {
          id: "material-1",
          path: "/courses/notes.md",
          addedAt: "2026-08-27T09:00:00.000Z",
        },
      ],
      proposedConcepts: [
        {
          id: "",
          name: "Invalid",
          sourceRefs: [
            {
              materialId: "material-1",
              path: "/courses/notes.md",
              locator: "# invalid",
            },
          ],
        },
      ],
    }),
  );

  await expect(store.getCourse(course.id)).rejects.toThrow("Invalid course");
});

test("rejects a persisted course with an invalid partial-answer policy", async () => {
  const { root, store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  await writeFile(
    join(root, "courses", course.id, "course.json"),
    JSON.stringify({ ...course, partialAnswerPolicy: "skip" }),
  );

  await expect(store.getCourse(course.id)).rejects.toThrow("Invalid course");
});

test("rejects a valid JSON catalog with an unsafe course ID", async () => {
  const { root, store } = await createStore();
  await writeFile(
    join(root, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      appliedOperationIds: [],
      courseIds: ["../outside-course"],
    }),
  );

  await expect(store.listCourses()).rejects.toThrow("Invalid catalog");
});

test("saves a course once per operation and validates revisions", async () => {
  const { store } = await createStore();
  const course = await store.createCourse("A", "op-create");
  const updated = await store.saveCourse(
    { ...course, name: "Renamed", revision: 1 },
    0,
    "op-rename",
  );

  const replayed = await store.saveCourse(
    { ...updated, name: "Ignored on replay", revision: 2 },
    1,
    "op-rename",
  );

  expect(replayed).toEqual(updated);
  await expect(
    store.saveCourse({ ...updated, revision: 2 }, 0, "op-stale"),
  ).rejects.toThrow(RevisionConflictError);
});

test("releases the course lock when a history mutation fails", async () => {
  const { store } = await createStore();
  const course = await store.createCourse("A", "op-create");

  await expect(
    store.commitHistory(course.id, 0, "op-fail", () => {
      throw new Error("mutation failed");
    }),
  ).rejects.toThrow("mutation failed");

  await expect(
    store.commitHistory(course.id, 0, "op-retry", (history) => ({
      ...history,
      revision: 1,
    })),
  ).resolves.toMatchObject({ revision: 1 });
});
