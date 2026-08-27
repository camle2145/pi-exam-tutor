import { writeFile } from "node:fs/promises";
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

test("persists course history across fresh store instances", async () => {
  const { root, ids, store: first } = await createStore();
  const course = await first.createCourse("Biology", "op-create");

  await first.commitHistory(course.id, 0, "op-history", (history) => ({
    ...history,
    revision: history.revision + 1,
  }));

  const second = new LocalStore(root, ids);
  expect((await second.getHistory(course.id)).revision).toBe(1);
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
