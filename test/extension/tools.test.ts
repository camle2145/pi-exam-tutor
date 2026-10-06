import { expect, test, vi } from "vitest";
import { registerTools } from "../../extensions/exam-tutor/tools.js";
import extension from "../../extensions/exam-tutor/index.js";
import type { SessionActivity } from "../../src/domain.js";
import {
  activeExam,
  awaitingGrade,
  course,
  createExtensionDependencies,
  exam,
  examGrade,
  idle,
  question,
  submittedExam,
} from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("exports the Pi tool registrar", () => {
  expect(registerTools).toBeTypeOf("function");
});

test("records all aggregate exam grades only from the canonical tool", async () => {
  const fake = createFakePi({ activity: submittedExam });
  const dependencies = createExtensionDependencies({
    recordExamGrades: vi.fn(async () => idle),
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  const result = await fake.executeTool("tutor_record_exam_grades", {
    grades: [examGrade],
  });

  expect(result.details.display).toContain("/courses/physics/notes.md");
  expect(dependencies.app.recordExamGrades).toHaveBeenCalledWith(
    submittedExam,
    [examGrade],
  );
});

test("accepts an empty aggregate grade array for an exam with no drafts", async () => {
  const zeroDraftExam: SessionActivity = {
    schemaVersion: 1,
    state: {
      tag: "exam-submitted",
      courseId: course.id,
      exam: {
        ...exam,
        status: "submitted",
        submittedAt: "2026-08-27T09:00:00.000Z",
        drafts: {},
      },
    },
  };
  const fake = createFakePi({ activity: zeroDraftExam });
  const dependencies = createExtensionDependencies({
    recordExamGrades: vi.fn(async () => idle),
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  const tool = fake.tool("tutor_record_exam_grades") as {
    parameters: { properties: { grades: { minItems?: number } } };
  };
  expect(tool.parameters.properties.grades.minItems).toBeUndefined();

  await fake.executeTool("tutor_record_exam_grades", { grades: [] });

  expect(dependencies.app.recordExamGrades).toHaveBeenCalledWith(
    zeroDraftExam,
    [],
  );
});

test("canonical grade tool calls one application use case and persists activity", async () => {
  const recordGrade = vi.fn(async () => idle);
  const dependencies = createExtensionDependencies({ recordGrade });
  const fake = createFakePi({ activity: awaitingGrade });
  extension(fake.api, dependencies);
  await fake.startSession();

  const result = await fake.executeTool("tutor_record_grade", {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
    sourceRef: question.sourceRefs[0],
  });

  expect(recordGrade).toHaveBeenCalledTimes(1);
  expect(recordGrade).toHaveBeenCalledWith(awaitingGrade, {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
  });
  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: idle,
  });
  expect(result).toMatchObject({
    content: [{ type: "text", text: "Grade recorded." }],
    details: { display: expect.stringContaining("Source:") },
  });
});

test("canonical tools reject a citation not configured for the current question", async () => {
  const recordGrade = vi.fn(async () => idle);
  const fake = createFakePi({ activity: awaitingGrade });
  extension(fake.api, createExtensionDependencies({ recordGrade }));
  await fake.startSession();

  await expect(
    fake.executeTool("tutor_record_grade", {
      correctness: "correct",
      gradingRationale: "Correct.",
      sourceRef: { ...question.sourceRefs[0], locator: "# unrelated" },
    }),
  ).rejects.toThrow("Citation is not configured");
  expect(recordGrade).not.toHaveBeenCalled();
  expect(fake.appendedEntries).toEqual([]);
});

test("present-exam rejects an invalid state before calling the application", async () => {
  const recordExam = vi.fn(async () => activeExam);
  const fake = createFakePi({ activity: idle });
  extension(fake.api, createExtensionDependencies({ recordExam }));
  await fake.startSession();

  await expect(
    fake.executeTool("tutor_present_exam", { items: exam.items }),
  ).rejects.toThrow("not currently being generated");
  expect(recordExam).not.toHaveBeenCalled();
});

test("present-exam rejects duplicate generated item IDs without persisting", async () => {
  const duplicateGeneratingExam: SessionActivity = {
    schemaVersion: 1,
    state: {
      tag: "exam-generating",
      courseId: course.id,
      operationId: "operation-duplicate",
      startedAt: "2026-08-27T09:00:00.000Z",
    },
  };
  const recordExam = vi.fn(async () => {
    throw new Error("Duplicate exam item ID: duplicate");
  });
  const duplicateItems = [
    { ...exam.items[0]!, id: "duplicate" },
    { ...exam.items[0]!, id: "duplicate" },
  ];
  const fake = createFakePi({ activity: duplicateGeneratingExam });
  extension(fake.api, createExtensionDependencies({ recordExam }));
  await fake.startSession();

  await expect(
    fake.executeTool("tutor_present_exam", { items: duplicateItems }),
  ).rejects.toThrow("Duplicate exam item ID: duplicate");
  expect(recordExam).toHaveBeenCalledWith(
    duplicateGeneratingExam,
    expect.objectContaining({ items: duplicateItems }),
  );
  expect(fake.appendedEntries).toEqual([]);
});

test("custom tool renderer exposes canonical learner-facing feedback", async () => {
  const fake = createFakePi({ activity: awaitingGrade });
  extension(
    fake.api,
    createExtensionDependencies({ recordGrade: vi.fn(async () => idle) }),
  );
  await fake.startSession();
  const result = await fake.executeTool("tutor_record_grade", {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
    sourceRef: question.sourceRefs[0],
  });
  const component = fake
    .tool("tutor_record_grade")
    ?.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text },
      {},
    );

  expect(component.render(120).join("\n")).toContain(
    "Acceleration changes velocity.",
  );
  expect(component.render(120).join("\n")).toContain(
    "/courses/physics/notes.md",
  );
});

test("all state-mutating tutor tools execute sequentially", () => {
  const fake = createFakePi();
  extension(fake.api, createExtensionDependencies());

  for (const name of fake.toolNames()) {
    expect(fake.tool(name)?.executionMode).toBe("sequential");
  }
});
