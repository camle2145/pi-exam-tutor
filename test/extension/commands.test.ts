import { expect, test, vi } from "vitest";
import { splitCommand } from "../../extensions/exam-tutor/commands.js";
import extension from "../../extensions/exam-tutor/index.js";
import {
  activeExam,
  activeExamWithAllDrafts,
  awaitingAnswer,
  awaitingGrade,
  conceptProposal,
  course,
  createExtensionDependencies,
  idle,
  submittedExam,
} from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("splits a slash command action from its remaining value", () => {
  expect(splitCommand("concepts approve newton-laws")).toEqual({
    action: "concepts",
    value: "approve newton-laws",
  });
});

test("requests cited concept extraction after adding a material", async () => {
  const fake = createFakePi({ activity: idle });
  const dependencies = createExtensionDependencies();
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
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining('"id":"material-1"'),
      }),
    }),
  );
});

test("keeps proposed concepts pending until an explicit approve command", async () => {
  const fake = createFakePi({ activity: idle });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.executeTool("tutor_propose_concepts", {
    proposals: [conceptProposal],
  });
  expect(dependencies.app.proposeConcepts).toHaveBeenCalledWith(course.id, [
    conceptProposal,
  ]);
  await fake.invokeCommand("course", "concepts approve newton-laws");
  expect(dependencies.app.approveConcepts).toHaveBeenCalledWith(course.id, [
    "newton-laws",
  ]);
});

test("clears a proposed concept parent when the parent command omits its ID", async () => {
  const fake = createFakePi({ activity: idle });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "concepts parent impulse");

  expect(dependencies.app.editProposedConcept).toHaveBeenCalledWith(
    course.id,
    "impulse",
    { parentId: null },
  );
});

test("locks every mode-changing command while an exam is active", async () => {
  const fake = createFakePi({ activity: activeExam });
  extension(
    fake.api,
    createExtensionDependencies({
      submitExam: vi.fn(async () => submittedExam),
    }),
  );
  await fake.startSession();

  for (const [command, args] of [
    ["study", ""],
    ["drill", ""],
    ["review", ""],
    ["exam", ""],
    ["hint", ""],
    ["reveal", ""],
    ["dashboard", ""],
    ["study-off", ""],
  ]) {
    await expect(fake.invokeCommand(command, args)).rejects.toThrow(
      "Finish the active exam",
    );
  }
  for (const args of [
    "create Other",
    "select course-1",
    "add /courses/physics/new.md",
    "concepts approve newton-laws",
  ]) {
    await expect(fake.invokeCommand("course", args)).rejects.toThrow(
      "Finish the active exam",
    );
  }
  await expect(fake.invokeCommand("exam", "submit")).resolves.toBeUndefined();
});

test("sends actual-ID draft answers only after exam submission", async () => {
  const fake = createFakePi({ activity: activeExamWithAllDrafts });
  fake.ui.custom.mockResolvedValueOnce(true);
  fake.ui.select.mockResolvedValueOnce("submit");
  const dependencies = createExtensionDependencies({
    submitExam: vi.fn(async () => submittedExam),
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("exam", "submit");

  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("Question ID: exam-question-id"),
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

test("resumes the matching deferred response with its draft", async () => {
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const fake = createFakePi({ activity: awaitingAnswer });
  fake.ui.custom
    .mockResolvedValueOnce({ kind: "deferred", draft: { answer: "draft" } })
    .mockResolvedValueOnce({
      kind: "submitted",
      answer: "draft",
      confidence: 60,
    });
  extension(fake.api, createExtensionDependencies({ acceptSubmission }));
  await fake.startSession();
  await fake.agentSettled();

  await fake.invokeCommand("resume-answer");

  expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
    answer: "draft",
    confidence: 60,
  });
});

test("uses interactive input when course creation omits its name", async () => {
  const dependencies = createExtensionDependencies();
  const fake = createFakePi();
  fake.ui.input.mockResolvedValueOnce("New course");
  extension(fake.api, dependencies);

  await fake.invokeCommand("course", "create");

  expect(fake.ui.input).toHaveBeenCalledWith("Course name");
  expect(dependencies.app.createCourse).toHaveBeenCalledWith("New course");
  expect(dependencies.app.selectCourse).toHaveBeenCalledTimes(1);
});

test("uses the custom TUI dashboard only in TUI mode", async () => {
  const fake = createFakePi({ activity: idle, mode: "tui" });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  await fake.invokeCommand("dashboard");

  expect(fake.ui.custom).toHaveBeenCalledTimes(1);
  expect(fake.sentMessages).toEqual([]);
});

test("renders dashboard as a non-triggering custom message outside TUI", async () => {
  const fake = createFakePi({ activity: idle, mode: "print" });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  await fake.invokeCommand("dashboard");

  expect(fake.ui.custom).not.toHaveBeenCalled();
  expect(fake.sentMessages).toContainEqual({
    message: expect.objectContaining({
      customType: "pi-exam-tutor/dashboard-v1",
      display: true,
      content: expect.stringContaining("Exam Tutor Dashboard"),
    }),
    options: { triggerTurn: false, deliverAs: "nextTurn" },
  });
});

test("study-off persists idle state and clears tutor status and widget", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  await fake.invokeCommand("study-off");

  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: idle,
  });
  expect(fake.ui.setStatus).toHaveBeenLastCalledWith("exam-tutor", undefined);
  expect(fake.ui.setWidget).toHaveBeenLastCalledWith("exam-tutor", undefined);
});
