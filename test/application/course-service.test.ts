import { expect, test } from "vitest";
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
