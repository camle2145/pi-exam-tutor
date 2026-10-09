import { expect, test, vi } from "vitest";
import { assertCourseInvariant, type Course } from "../../src/domain.js";
import { createApplicationFixture } from "./setup.js";

test("selects an existing course as an idle activity", async () => {
  const { app, course } = await createApplicationFixture();

  await expect(
    app.selectCourse(course.id, { schemaVersion: 1, state: { tag: "idle" } }),
  ).resolves.toEqual({
    schemaVersion: 1,
    state: { tag: "idle", courseId: course.id },
  });
});

test("keeps extracted concepts pending until a learner approves them", async () => {
  const { app, course } = await createApplicationFixture();
  const sourceRefs = [
    {
      materialId: "material-1",
      path: "/courses/physics/notes.md",
      locator: "# newton-laws",
    },
  ];

  const proposed = await app.proposeConcepts(course.id, [
    { id: "newton-laws", name: "Newton's laws", sourceRefs },
  ]);
  expect(proposed.concepts).toEqual([{ id: "kinematics", name: "Kinematics" }]);
  expect(proposed.proposedConcepts).toHaveLength(1);

  const approved = await app.approveConcepts(course.id, ["newton-laws"]);
  expect(approved.concepts).toMatchObject([
    { id: "kinematics", name: "Kinematics" },
    { id: "newton-laws", name: "Newton's laws" },
  ]);
  expect(approved.proposedConcepts).toEqual([]);
});

test("rejects a concept proposal whose source is not configured", async () => {
  const { app, course } = await createApplicationFixture();

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

test("rejects non-normalized material paths through the facade", async () => {
  const { app, course } = await createApplicationFixture();

  await expect(
    app.addMaterial(course.id, "/courses/physics/../notes.md"),
  ).rejects.toThrow("Material path must be absolute and normalized");
});

test("adds one material through the singular facade", async () => {
  const { app, course, store } = await createApplicationFixture();
  const path = "/courses/physics/week-1.md";

  const updated = await app.addMaterial(course.id, path);

  expect(updated.revision).toBe(course.revision + 1);
  expect(
    updated.materials.map(({ path: materialPath }) => materialPath),
  ).toEqual(["/courses/physics/notes.md", path]);
  await expect(store.getCourse(course.id)).resolves.toEqual(updated);
});

test("adds a batch of material paths atomically", async () => {
  const { app, course } = await createApplicationFixture();

  const updated = await app.addMaterials(course.id, [
    "/courses/physics/week-1.md",
    "/courses/physics/week-2.md",
  ]);

  expect(updated.revision).toBe(course.revision + 1);
  const addedMaterialIds = updated.materials
    .slice(course.materials.length)
    .map(({ id }) => id);
  expect(addedMaterialIds).toEqual([expect.any(String), expect.any(String)]);
  expect(new Set(addedMaterialIds).size).toBe(2);
  expect(updated.materials.map(({ path }) => path)).toEqual([
    "/courses/physics/notes.md",
    "/courses/physics/week-1.md",
    "/courses/physics/week-2.md",
  ]);
});

test("does not persist part of an invalid material batch", async () => {
  const { app, course, store } = await createApplicationFixture();
  const saveCourse = vi.spyOn(store, "saveCourse");

  await expect(
    app.addMaterials(course.id, [
      "/courses/physics/week-1.md",
      "/courses/physics/../outside.md",
    ]),
  ).rejects.toThrow("Material path must be absolute and normalized");

  expect(saveCourse).not.toHaveBeenCalled();
  await expect(store.getCourse(course.id)).resolves.toEqual(course);
});

test("does not persist a material batch with duplicate input paths", async () => {
  const { app, course, store } = await createApplicationFixture();
  const saveCourse = vi.spyOn(store, "saveCourse");

  await expect(
    app.addMaterials(course.id, [
      "/courses/physics/week-1.md",
      "/courses/physics/week-1.md",
    ]),
  ).rejects.toThrow();

  expect(saveCourse).not.toHaveBeenCalled();
  await expect(store.getCourse(course.id)).resolves.toEqual(course);
});

test("does not persist a material batch with an already configured path", async () => {
  const { app, course, store } = await createApplicationFixture();
  const saveCourse = vi.spyOn(store, "saveCourse");

  await expect(
    app.addMaterials(course.id, [
      "/courses/physics/week-1.md",
      "/courses/physics/notes.md",
    ]),
  ).rejects.toThrow(
    "Material path is already configured: /courses/physics/notes.md",
  );

  expect(saveCourse).not.toHaveBeenCalled();
  await expect(store.getCourse(course.id)).resolves.toEqual(course);
});

test("leaves stored materials unchanged when saving a batch fails", async () => {
  const { app, course, store } = await createApplicationFixture();
  const saveCourse = vi
    .spyOn(store, "saveCourse")
    .mockRejectedValueOnce(new Error("save failed"));

  await expect(
    app.addMaterials(course.id, ["/courses/physics/week-1.md"]),
  ).rejects.toThrow("save failed");

  expect(saveCourse).toHaveBeenCalledTimes(1);
  await expect(store.getCourse(course.id)).resolves.toEqual(course);
});

test("does not add an empty material batch", async () => {
  const { app, course, store } = await createApplicationFixture();
  const saveCourse = vi.spyOn(store, "saveCourse");

  await expect(app.addMaterials(course.id, [])).rejects.toThrow();

  expect(saveCourse).not.toHaveBeenCalled();
  await expect(store.getCourse(course.id)).resolves.toEqual(course);
});

test("replaces stale pending concepts with a fresh extraction batch", async () => {
  const { app, course } = await createApplicationFixture();
  const sourceRefs = [
    {
      materialId: "material-1",
      path: "/courses/physics/notes.md",
      locator: "# x",
    },
  ];
  await app.proposeConcepts(course.id, [
    { id: "stale", name: "Stale", sourceRefs },
  ]);

  const replaced = await app.proposeConcepts(course.id, [
    { id: "fresh", name: "Fresh", sourceRefs },
  ]);

  expect(replaced.proposedConcepts).toEqual([
    { id: "fresh", name: "Fresh", sourceRefs },
  ]);
});

test("rejects multi-node concept parent cycles", async () => {
  const { course } = await createApplicationFixture();
  expect(() =>
    assertCourseInvariant({
      ...course,
      proposedConcepts: [
        {
          id: "a",
          name: "A",
          parentId: "b",
          sourceRefs: [questionSource(course)],
        },
        {
          id: "b",
          name: "B",
          parentId: "a",
          sourceRefs: [questionSource(course)],
        },
      ],
    }),
  ).toThrow("Concept parent cycle");
});

function questionSource(course: Course) {
  return {
    materialId: course.materials[0]!.id,
    path: course.materials[0]!.path,
    locator: "# cycle",
  };
}

test("clears a pending concept parent only when explicitly requested", async () => {
  const { app, course } = await createApplicationFixture();
  const proposed = await app.proposeConcepts(course.id, [
    {
      id: "laws",
      name: "Laws",
      sourceRefs: [
        {
          materialId: "material-1",
          path: "/courses/physics/notes.md",
          locator: "# laws",
        },
      ],
    },
    {
      id: "impulse",
      name: "Impulse",
      parentId: "laws",
      sourceRefs: [
        {
          materialId: "material-1",
          path: "/courses/physics/notes.md",
          locator: "# impulse",
        },
      ],
    },
  ]);

  const cleared = await app.editProposedConcept(course.id, "impulse", {
    parentId: null,
  });

  expect(
    proposed.proposedConcepts.find(({ id }) => id === "impulse")?.parentId,
  ).toBe("laws");
  expect(
    cleared.proposedConcepts.find(({ id }) => id === "impulse")?.parentId,
  ).toBeUndefined();
});
