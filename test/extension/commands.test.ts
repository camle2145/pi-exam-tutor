import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { splitCommand } from "../../extensions/exam-tutor/commands.js";
import extension from "../../extensions/exam-tutor/index.js";
import type { SessionActivity } from "../../src/domain.js";
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

const materialRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    materialRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function materialFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exam-tutor-command-materials-"));
  materialRoots.push(root);
  await mkdir(join(root, "materials", "nested"), { recursive: true });
  await writeFile(join(root, "overview.md"), "overview");
  await writeFile(join(root, "materials", "lecture.md"), "lecture");
  await writeFile(join(root, "materials", "worksheet.pdf"), "worksheet");
  await writeFile(join(root, "materials", "nested", "solution.md"), "solution");
  await writeFile(join(root, "materials", "existing.md"), "existing");
  await writeFile(join(root, "Filter extensions…"), "filter-named-file");
  await writeFile(
    join(root, "Filter extensions… (file)"),
    "similarly-named-file",
  );
  return root;
}

test("adds a typed relative folder atomically", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.confirm.mockResolvedValueOnce(true);
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add materials");

  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "materials", "existing.md"),
    join(root, "materials", "lecture.md"),
    join(root, "materials", "nested", "solution.md"),
    join(root, "materials", "worksheet.pdf"),
  ]);
  expect(dependencies.app.addMaterials).toHaveBeenCalledTimes(1);
  expect(fake.ui.confirm).toHaveBeenCalledWith(
    "Add course materials",
    expect.stringContaining("4 material file(s) from materials"),
  );
  expect(dependencies.app.addMaterial).not.toHaveBeenCalled();
  expect(fake.sentMessages).toHaveLength(1);
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
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining(
          "Prioritize concepts highlighted in course-material summaries, study guides, and learning objectives when those sections are present.",
        ),
      }),
    }),
  );
});

test("browses a folder, excludes configured files, and extracts once", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select
    .mockResolvedValueOnce("materials/")
    .mockResolvedValueOnce("Add this folder recursively");
  fake.ui.confirm.mockResolvedValueOnce(true);
  const dependencies = createExtensionDependencies();
  vi.mocked(dependencies.store.getCourse).mockResolvedValue({
    ...course,
    materials: [
      { ...course.materials[0]!, path: join(root, "materials", "existing.md") },
    ],
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(fake.ui.confirm).toHaveBeenCalledWith(
    "Add course materials",
    expect.stringContaining("3 material file(s) from materials"),
  );
  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "materials", "lecture.md"),
    join(root, "materials", "nested", "solution.md"),
    join(root, "materials", "worksheet.pdf"),
  ]);
  expect(dependencies.app.addMaterials).toHaveBeenCalledTimes(1);
  expect(fake.sentMessages).toHaveLength(1);
});

test("browses and adds an individual material file", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select.mockResolvedValueOnce("overview.md");
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "overview.md"),
  ]);
  expect(dependencies.app.addMaterial).not.toHaveBeenCalled();
  expect(fake.sentMessages).toHaveLength(1);
});

test("browses from the root into a child and selects a nested file", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select
    .mockResolvedValueOnce("materials/")
    .mockResolvedValueOnce("nested/")
    .mockResolvedValueOnce("solution.md");
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "materials", "nested", "solution.md"),
  ]);
  expect(fake.ui.select.mock.calls.map(([title]) => title)).toEqual([
    "Add course materials: .",
    "Add course materials: materials",
    "Add course materials: materials/nested",
  ]);
});

test("navigates to a parent only below the root", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select
    .mockResolvedValueOnce("materials/")
    .mockResolvedValueOnce("nested/")
    .mockResolvedValueOnce("..")
    .mockResolvedValueOnce("..")
    .mockResolvedValueOnce("overview.md");
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "overview.md"),
  ]);
  expect(fake.ui.select.mock.calls.map(([, choices]) => choices)).toEqual([
    expect.not.arrayContaining([".."]),
    expect.arrayContaining([".."]),
    expect.arrayContaining([".."]),
    expect.arrayContaining([".."]),
    expect.not.arrayContaining([".."]),
  ]);
});

test("recursively imports the currently viewed child folder", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select
    .mockResolvedValueOnce("materials/")
    .mockResolvedValueOnce("Add this folder recursively");
  fake.ui.confirm.mockResolvedValueOnce(true);
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(fake.ui.confirm).toHaveBeenCalledWith(
    "Add course materials",
    expect.stringContaining("4 material file(s) from materials"),
  );
  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "materials", "existing.md"),
    join(root, "materials", "lecture.md"),
    join(root, "materials", "nested", "solution.md"),
    join(root, "materials", "worksheet.pdf"),
  ]);
});

test("selects a file named like the filter action instead of opening the filter", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select.mockResolvedValueOnce("Filter extensions… (file)");
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(fake.ui.select.mock.calls[0]?.[1]).toContain("Filter extensions…");
  expect(fake.ui.select.mock.calls[0]?.[1]).toContain(
    "Filter extensions… (file)",
  );
  expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "Filter extensions…"),
  ]);
  expect(fake.ui.confirm).not.toHaveBeenCalled();
  expect(fake.sentMessages).toHaveLength(1);
});

test("uniquely selects the filter action and both similarly named files", async () => {
  const root = await materialFixtureRoot();

  const actionFake = createFakePi({ activity: idle, cwd: root });
  let actionSelections = 0;
  actionFake.ui.select.mockImplementation(
    async (_message: string, choices: string[]) => {
      actionSelections += 1;
      if (actionSelections === 1) return "Filter extensions…";
      return choices.find((choice) => choice === "Filter extensions… (file)");
    },
  );
  const actionDependencies = createExtensionDependencies();
  extension(actionFake.api, actionDependencies);
  await actionFake.startSession();
  await actionFake.invokeCommand("course", "add");

  expect(actionFake.ui.custom).toHaveBeenCalledTimes(1);
  expect(actionDependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
    join(root, "Filter extensions…"),
  ]);

  for (const [label, filename] of [
    ["Filter extensions… (file)", "Filter extensions…"],
    [
      "Filter extensions… (file) [Filter extensions… (file)]",
      "Filter extensions… (file)",
    ],
  ] as const) {
    const fake = createFakePi({ activity: idle, cwd: root });
    fake.ui.select.mockImplementationOnce(
      async (_message: string, choices: string[]) =>
        choices.find((choice) => choice === label),
    );
    const dependencies = createExtensionDependencies();
    extension(fake.api, dependencies);
    await fake.startSession();
    await fake.invokeCommand("course", "add");

    expect(dependencies.app.addMaterials).toHaveBeenCalledWith(course.id, [
      join(root, filename),
    ]);
  }
});

test("does not add or extract when folder import is not confirmed", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  fake.ui.select
    .mockResolvedValueOnce("materials/")
    .mockResolvedValueOnce("Add this folder recursively");
  fake.ui.confirm.mockResolvedValueOnce(false);
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
  expect(fake.sentMessages).toEqual([]);
});

test("does not add empty typed selections", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  const dependencies = createExtensionDependencies();
  vi.mocked(dependencies.store.getCourse).mockResolvedValue({
    ...course,
    materials: [
      { ...course.materials[0]!, path: join(root, "materials", "existing.md") },
    ],
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add materials/existing.md");

  expect(fake.ui.notify).toHaveBeenCalledWith(
    "No new matching material files found",
    "error",
  );
  expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
  expect(fake.sentMessages).toEqual([]);
});

test("requires a relative path outside TUI mode", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root, mode: "print" });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add");

  expect(fake.ui.notify).not.toHaveBeenCalled();
  expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
  expect(fake.sentMessages).toEqual([]);
});

test.each(['""', "''"])(
  "rejects an explicitly supplied empty quoted path in TUI: %s",
  async (quotedPath) => {
    const root = await materialFixtureRoot();
    const fake = createFakePi({ activity: idle, cwd: root });
    const dependencies = createExtensionDependencies();
    extension(fake.api, dependencies);
    await fake.startSession();

    await fake.invokeCommand("course", `add ${quotedPath}`);

    expect(fake.ui.notify).toHaveBeenCalledWith(
      "A relative material path is required",
      "error",
    );
    expect(fake.ui.select).not.toHaveBeenCalled();
    expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
    expect(fake.sentMessages).toEqual([]);
  },
);

test.each(['""', "''"])(
  "does not import the root for an explicitly supplied empty quoted path outside TUI: %s",
  async (quotedPath) => {
    const root = await materialFixtureRoot();
    const fake = createFakePi({ activity: idle, cwd: root, mode: "print" });
    const dependencies = createExtensionDependencies();
    extension(fake.api, dependencies);
    await fake.startSession();

    await expect(
      fake.invokeCommand("course", `add ${quotedPath}`),
    ).rejects.toThrow("A relative material path is required");

    expect(fake.ui.select).not.toHaveBeenCalled();
    expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
    expect(fake.sentMessages).toEqual([]);
  },
);

test("rejects absolute material paths without calling the application", async () => {
  const root = await materialFixtureRoot();
  const fake = createFakePi({ activity: idle, cwd: root });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "add /tmp/material.md");

  expect(fake.ui.notify).toHaveBeenCalledWith(
    "Material path must be relative to Pi's launch directory",
    "error",
  );
  expect(dependencies.app.addMaterials).not.toHaveBeenCalled();
  expect(fake.sentMessages).toEqual([]);
});

test("approves proposed concepts only through an explicit course command", async () => {
  const fake = createFakePi({ activity: idle });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "concepts approve newton-laws");

  expect(dependencies.app.approveConcepts).toHaveBeenCalledWith(course.id, [
    "newton-laws",
  ]);
});

test("returns to the compact pending-concepts list after approving one proposal", async () => {
  const first = conceptProposal;
  const second = {
    ...conceptProposal,
    id: "impulse",
    name: "Impulse",
  };
  let currentCourse = {
    ...course,
    proposedConcepts: [first, second],
  };
  const dependencies = createExtensionDependencies({
    approveConcepts: vi.fn(async (_courseId, ids: readonly string[]) => {
      currentCourse = {
        ...currentCourse,
        proposedConcepts: currentCourse.proposedConcepts.filter(
          ({ id }) => !ids.includes(id),
        ),
      };
      return currentCourse;
    }),
  });
  vi.mocked(dependencies.store.getCourse).mockImplementation(
    async () => currentCourse,
  );
  const fake = createFakePi({ activity: idle });
  fake.ui.select
    .mockResolvedValueOnce("Newton's laws · newton-laws")
    .mockResolvedValueOnce("approve")
    .mockResolvedValueOnce(undefined);
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "concepts");

  expect(dependencies.app.approveConcepts).toHaveBeenCalledWith(course.id, [
    "newton-laws",
  ]);
  expect(fake.ui.select).toHaveBeenNthCalledWith(
    1,
    "Pending concepts",
    expect.arrayContaining([
      "Approve all pending concepts",
      "Newton's laws · newton-laws",
      "Impulse · impulse",
    ]),
  );
  expect(fake.ui.select).toHaveBeenNthCalledWith(
    2,
    "Concept action",
    expect.arrayContaining([
      "approve",
      "details",
      "rename",
      "parent",
      "remove",
    ]),
  );
  expect(fake.ui.select).toHaveBeenNthCalledWith(
    3,
    "Pending concepts",
    expect.arrayContaining(["Impulse · impulse"]),
  );
  expect(fake.ui.select.mock.calls[2]?.[1]).not.toContain(
    "Newton's laws · newton-laws",
  );
});

test("approves all pending concepts only after confirmation", async () => {
  const first = conceptProposal;
  const second = {
    ...conceptProposal,
    id: "impulse",
    name: "Impulse",
  };
  let currentCourse = {
    ...course,
    proposedConcepts: [first, second],
  };
  const dependencies = createExtensionDependencies({
    approveConcepts: vi.fn(async (_courseId, ids: readonly string[]) => {
      currentCourse = {
        ...currentCourse,
        proposedConcepts:
          ids.length === 0
            ? []
            : currentCourse.proposedConcepts.filter(
                ({ id }) => !ids.includes(id),
              ),
      };
      return currentCourse;
    }),
  });
  vi.mocked(dependencies.store.getCourse).mockImplementation(
    async () => currentCourse,
  );
  const fake = createFakePi({ activity: idle });
  fake.ui.select.mockResolvedValueOnce("Approve all pending concepts");
  fake.ui.confirm.mockResolvedValueOnce(true);
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "concepts");

  expect(fake.ui.confirm).toHaveBeenCalledWith(
    "Approve all pending concepts",
    "Approve all 2 pending concept proposals?",
  );
  expect(dependencies.app.approveConcepts).toHaveBeenCalledWith(course.id, []);
  expect(fake.ui.select).toHaveBeenCalledTimes(1);
  expect(fake.ui.select).not.toHaveBeenCalledWith(
    "Course action",
    expect.anything(),
  );
});

test("cancelling approval of all pending concepts keeps the list open", async () => {
  const first = conceptProposal;
  const second = {
    ...conceptProposal,
    id: "impulse",
    name: "Impulse",
  };
  const currentCourse = {
    ...course,
    proposedConcepts: [first, second],
  };
  const dependencies = createExtensionDependencies();
  vi.mocked(dependencies.store.getCourse).mockResolvedValue(currentCourse);
  const fake = createFakePi({ activity: idle });
  fake.ui.select
    .mockResolvedValueOnce("Approve all pending concepts")
    .mockResolvedValueOnce(undefined);
  fake.ui.confirm.mockResolvedValueOnce(false);
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("course", "concepts");

  expect(dependencies.app.approveConcepts).not.toHaveBeenCalled();
  expect(fake.ui.select).toHaveBeenCalledTimes(2);
  expect(fake.ui.select.mock.calls.map(([title]) => title)).toEqual([
    "Pending concepts",
    "Pending concepts",
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

test("study-off returns to the selected course through the application facade", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("study-off");

  expect(dependencies.app.selectCourse).toHaveBeenCalledWith(
    course.id,
    awaitingAnswer,
  );
  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: idle,
  });
  expect(fake.ui.setStatus).toHaveBeenLastCalledWith("exam-tutor", undefined);
  expect(fake.ui.setWidget).toHaveBeenLastCalledWith("exam-tutor", undefined);
});

test("study-off preserves an idle session without a selected course", async () => {
  const unselected: SessionActivity = {
    schemaVersion: 1,
    state: { tag: "idle" },
  };
  const fake = createFakePi({ activity: unselected });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("study-off");

  expect(dependencies.app.selectCourse).not.toHaveBeenCalled();
  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: unselected,
  });
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
