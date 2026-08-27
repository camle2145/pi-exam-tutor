import { expect, test } from "vitest";
import {
  assertCourseInvariant,
  assertQuestion,
  type Course,
  type Question,
} from "../src/domain.js";

const course: Course = {
  schemaVersion: 1,
  id: "course-1",
  name: "Physics",
  revision: 0,
  createdAt: "2026-08-27T09:00:00.000Z",
  appliedOperationIds: [],
  materials: [
    {
      id: "material-1",
      path: "/courses/physics/notes.md",
      addedAt: "2026-08-27T09:00:00.000Z",
    },
  ],
  concepts: [{ id: "kinematics", name: "Kinematics" }],
};

const question: Question = {
  id: "question-1",
  kind: "primary",
  targetConceptId: "kinematics",
  prompt: "How does acceleration affect velocity?",
  sourceRefs: [
    {
      materialId: "material-1",
      path: "/courses/physics/notes.md",
      locator: "# acceleration",
    },
  ],
};

test("rejects a question that targets no configured concept", () => {
  expect(() =>
    assertQuestion(course, { ...question, targetConceptId: "missing" }),
  ).toThrow("Unknown target concept: missing");
});

test("rejects a source path outside the selected course", () => {
  expect(() =>
    assertQuestion(course, {
      ...question,
      sourceRefs: [
        { materialId: "material-1", path: "/tmp/outside.md", locator: "# x" },
      ],
    }),
  ).toThrow("Source path is not configured for this course");
});

test("rejects duplicate material paths", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      materials: [
        ...course.materials,
        {
          id: "material-2",
          path: "/courses/physics/notes.md",
          addedAt: "2026-08-27T09:00:00.000Z",
        },
      ],
    }),
  ).toThrow("Duplicate material path: /courses/physics/notes.md");
});

test("rejects duplicate concept identifiers", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      concepts: [...course.concepts, { id: "kinematics", name: "Motion" }],
    }),
  ).toThrow("Duplicate concept id: kinematics");
});

test("rejects a non-normalized material path", () => {
  expect(() =>
    assertCourseInvariant({
      ...course,
      materials: [
        {
          ...course.materials[0]!,
          path: "/courses/physics/../physics/notes.md",
        },
      ],
    }),
  ).toThrow("Material path must be absolute and normalized");
});
