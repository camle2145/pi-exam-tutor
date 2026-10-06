import { expect, test, vi } from "vitest";
import extension from "../../extensions/exam-tutor/index.js";
import { createExamController } from "../../extensions/exam-tutor/exam-controller.js";
import type { SessionCoordinator } from "../../extensions/exam-tutor/runtime.js";
import type { SessionActivity } from "../../src/domain.js";
import {
  activeExam,
  course,
  createExtensionDependencies,
  exam,
  generatingExam,
  now,
  submittedExam,
  twoExamItems,
} from "./fixtures.js";
import {
  createFakePi,
  lastPersistedDraft,
  messageText,
  reviewText,
} from "./fake-pi.js";

// The extension integration cases exercise the extracted exam-controller seam.
test("renders only the active exam item without source references", async () => {
  const fake = createFakePi({ activity: generatingExam });
  extension(
    fake.api,
    createExtensionDependencies({
      recordExam: vi.fn(async (_current, presented) => ({
        schemaVersion: 1,
        state: { tag: "exam-active", courseId: course.id, exam: presented },
      })),
    }),
  );
  await fake.startSession();

  const result = await fake.executeTool("tutor_present_exam", {
    items: twoExamItems,
  });
  await fake.agentSettled();

  expect(result).toMatchObject({
    content: [{ type: "text", text: "Exam ready." }],
    details: { display: "Exam ready." },
  });
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
  expect(fake.sentMessages.flatMap(messageText)).not.toContain("second prompt");
  expect(
    JSON.stringify(
      fake.sentMessages.find(
        (sent) =>
          (sent as { message?: { customType?: string } }).message
            ?.customType === "pi-exam-tutor/exam-item-v1",
      ),
    ),
  ).not.toContain("/courses/physics/notes.md");
});

test("saves an exam answer only after confidence and advances to the next item", async () => {
  const fake = createFakePi({ activity: generatingExam });
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "First",
    confidence: 80,
  });
  let presentedActivity: SessionActivity;
  const dependencies = createExtensionDependencies({
    recordExam: vi.fn(async (_current, presented) => {
      presentedActivity = {
        schemaVersion: 1,
        state: { tag: "exam-active", courseId: course.id, exam: presented },
      };
      return presentedActivity;
    }),
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.executeTool("tutor_present_exam", { items: twoExamItems });
  await fake.agentSettled();
  await vi.waitFor(() => {
    expect(dependencies.app.saveExamDraft).toHaveBeenCalledTimes(1);
  });

  expect(fake.appendedEntries.at(-1)).toMatchObject({
    data: {
      state: { exam: { drafts: { "1": { answer: "First", confidence: 80 } } } },
    },
  });
  expect(dependencies.app.saveExamDraft).toHaveBeenCalledWith(
    presentedActivity,
    "1",
    {
      answer: "First",
      confidence: 80,
      submittedAt: now.toISOString(),
    },
  );
  expect(
    fake.sentMessages
      .map(
        (sent) =>
          (sent as { message?: { content?: unknown } }).message?.content,
      )
      .filter((content): content is string => typeof content === "string")
      .at(-1),
  ).toContain("second prompt");
});

test("resumes a deferred unanswered exam response with prefilled reconfirmable confidence", async () => {
  const fake = createFakePi({ activity: activeExam });
  fake.ui.custom
    .mockResolvedValueOnce({
      kind: "deferred",
      draft: { answer: "later", confidence: 80 },
    })
    .mockImplementationOnce(
      async (factory) =>
        new Promise((resolve) => {
          const panel = factory(
            { requestRender: vi.fn(), terminal: { rows: 40 } },
            {
              fg: (_color: string, text: string) => text,
              borderColor: (text: string) => text,
            },
            {},
            resolve,
          );
          expect(panel.render(120).join("\n")).toContain("later");
          panel.handleInput("\r");
        }),
    )
    .mockImplementationOnce(
      async (factory) =>
        new Promise((resolve) => {
          const panel = factory(
            { requestRender: vi.fn(), terminal: { rows: 40 } },
            {
              fg: (_color: string, text: string) => text,
              borderColor: (text: string) => text,
            },
            {},
            resolve,
          );
          expect(panel.value()).toBe(80);
          expect(panel.render(120).join("\n")).toContain(
            "Confidence: 80 / 100 (adjust or type to confirm)",
          );
          panel.handleInput("\x1b[D");
          panel.handleInput("\r");
        }),
    );
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.agentSettled();
  await vi.waitFor(() => {
    expect(fake.ui.custom).toHaveBeenCalledTimes(1);
  });
  await fake.agentSettled();

  await vi.waitFor(() => {
    expect(fake.ui.custom).toHaveBeenCalledTimes(3);
  });
  expect(dependencies.app.saveExamDraft).toHaveBeenCalledWith(activeExam, "1", {
    answer: "later",
    confidence: 75,
    submittedAt: now.toISOString(),
  });
  expect(fake.appendedEntries.at(-1)).toMatchObject({
    data: {
      state: {
        exam: {
          drafts: {
            "1": {
              answer: "later",
              confidence: 75,
            },
          },
        },
      },
    },
  });
});

test("reopens a cancelled unanswered exam item without duplicate panels", async () => {
  const fake = createFakePi({ activity: activeExam });
  fake.ui.custom
    .mockResolvedValueOnce({ kind: "cancelled" })
    .mockResolvedValueOnce({
      kind: "submitted",
      answer: "Acceleration changes velocity.",
      confidence: 80,
    });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.agentSettled();
  await fake.agentSettled();
  await fake.agentSettled();

  expect(dependencies.app.saveExamDraft).toHaveBeenCalledWith(activeExam, "1", {
    answer: "Acceleration changes velocity.",
    confidence: 80,
    submittedAt: now.toISOString(),
  });
  expect(fake.ui.custom).toHaveBeenCalledTimes(2);
  expect(fake.appendedEntries.at(-1)).toMatchObject({
    data: {
      state: {
        exam: {
          drafts: {
            "1": {
              answer: "Acceleration changes velocity.",
              confidence: 80,
            },
          },
        },
      },
    },
  });
});

test("does not overwrite a saved exam draft before reconfirmed confidence", async () => {
  const savedExam: SessionActivity = {
    schemaVersion: 1,
    state: {
      tag: "exam-active",
      courseId: course.id,
      exam: {
        ...exam,
        drafts: {
          "1": {
            answer: "original",
            confidence: 80,
            submittedAt: now.toISOString(),
          },
        },
      },
    },
  };
  const fake = createFakePi({ activity: savedExam });
  fake.ui.custom.mockResolvedValueOnce({
    kind: "deferred",
    draft: { answer: "changed", confidence: 80 },
  });
  fake.ui.select.mockResolvedValueOnce("resume");
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.invokeCommand("exam", "edit 1");

  expect(lastPersistedDraft(fake, "1")).toBeUndefined();
  expect(fake.appendedEntries).toEqual([]);
  await expect(fake.invokeCommand("exam", "submit")).resolves.toBeUndefined();
  expect(fake.ui.select).toHaveBeenCalledWith(
    expect.stringContaining("pending edit"),
    expect.arrayContaining(["resume", "discard"]),
  );
  expect(dependencies.app.submitExam).not.toHaveBeenCalled();
});

test("shows review before manually submitting a partial exam", async () => {
  const fake = createFakePi({ activity: activeExam });
  fake.ui.custom.mockResolvedValueOnce(true);
  fake.ui.select.mockResolvedValueOnce("submit");
  extension(
    fake.api,
    createExtensionDependencies({
      submitExam: vi.fn(async () => submittedExam),
    }),
  );
  await fake.startSession();

  await fake.invokeCommand("exam", "submit");

  expect(fake.ui.custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.anything(),
  );
  expect(reviewText(fake)).toContain("Unanswered");
});

test("does not submit a partial exam manually without an interactive review", async () => {
  const submitExam = vi.fn(async () => submittedExam);
  const fake = createFakePi({ activity: activeExam, mode: "print" });
  extension(fake.api, createExtensionDependencies({ submitExam }));
  await fake.startSession();

  await fake.invokeCommand("exam", "submit");

  expect(submitExam).not.toHaveBeenCalled();
  expect(fake.appendedEntries).toEqual([]);
});
test("retains bulk exam draft parsing only without a UI", async () => {
  const fake = createFakePi({ activity: activeExam, mode: "print" });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  const result = await fake.dispatchInput("1. [confidence: 80]\nanswer");

  expect(result).toEqual({ action: "handled" });
  expect(fake.sentMessages).toEqual([]);
  expect(fake.appendedEntries.at(-1)).toMatchObject({
    customType: "pi-exam-tutor/activity-v1",
    data: {
      state: {
        tag: "exam-active",
        exam: { drafts: { "1": { answer: "answer", confidence: 80 } } },
      },
    },
  });
  expect(dependencies.app.saveExamDraft).toHaveBeenCalledWith(
    activeExam,
    "1",
    expect.objectContaining({
      answer: "answer",
      confidence: 80,
      submittedAt: now.toISOString(),
    }),
  );
});

test("submits an active exam locally when its deadline expires", async () => {
  vi.useFakeTimers();
  try {
    const timedExam: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-active",
        courseId: course.id,
        exam: {
          ...exam,
          deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
    };
    const submitted: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-submitted",
        courseId: course.id,
        exam: {
          ...exam,
          deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
          submittedAt: new Date(now.getTime() + 60_000).toISOString(),
          status: "expired",
        },
      },
    };
    const submitExam = vi.fn(async () => submitted);
    const fake = createFakePi({ activity: timedExam });
    extension(fake.api, createExtensionDependencies({ submitExam }));
    await fake.startSession();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(submitExam).toHaveBeenCalledTimes(1);
    expect(submitExam).toHaveBeenCalledWith(timedExam);
    expect(fake.appendedEntries.at(-1)).toEqual({
      customType: "pi-exam-tutor/activity-v1",
      data: submitted,
    });
    expect(fake.sentMessages).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("does not let a pending answer panel overwrite deadline submission", async () => {
  vi.useFakeTimers();
  try {
    const deadlineAt = new Date(now.getTime() + 60_000).toISOString();
    const timedExam: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-active",
        courseId: course.id,
        exam: { ...exam, deadlineAt },
      },
    };
    const submitted: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-submitted",
        courseId: course.id,
        exam: {
          ...exam,
          deadlineAt,
          submittedAt: deadlineAt,
          status: "expired",
        },
      },
    };
    let resolvePanel!: (result: unknown) => void;
    const fake = createFakePi({ activity: timedExam });
    fake.ui.custom.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePanel = resolve;
        }),
    );
    const submitExam = vi.fn(async () => submitted);
    const dependencies = createExtensionDependencies({ submitExam });
    extension(fake.api, dependencies);
    await fake.startSession();
    await fake.agentSettled();
    expect(fake.ui.custom).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    resolvePanel({
      kind: "submitted",
      answer: "Late answer",
      confidence: 80,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(dependencies.app.saveExamDraft).not.toHaveBeenCalled();
    expect(fake.appendedEntries.at(-1)).toEqual({
      customType: "pi-exam-tutor/activity-v1",
      data: submitted,
    });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(submitExam).toHaveBeenCalledTimes(1);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]).toMatchObject({
      message: {
        content: expect.stringContaining(
          "Call tutor_record_exam_grades exactly once",
        ),
      },
      options: { triggerTurn: true },
    });
  } finally {
    vi.useRealTimers();
  }
});

test("rejects malformed bulk exam drafts only without a UI", async () => {
  const fake = createFakePi({ activity: activeExam, mode: "print" });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  expect(await fake.dispatchInput("answer without confidence")).toEqual({
    action: "handled",
  });
  expect(fake.appendedEntries).toEqual([]);
  expect(fake.sentMessages).toEqual([]);
  expect(fake.ui.notify).not.toHaveBeenCalled();
});

test("saves an exam answer through the application facade", async () => {
  const fake = createFakePi({ activity: activeExam });
  const dependencies = createExtensionDependencies();
  const coordinator = {
    activity: () => activeExam,
    persist: vi.fn(),
    triggerTurn: vi.fn(),
    setDeferredResponse: vi.fn(),
  } as unknown as SessionCoordinator;
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "Velocity changes.",
    confidence: 70,
  });
  const controller = createExamController(
    fake.api,
    coordinator,
    dependencies.app,
    { now: () => now },
    vi.fn(),
  );
  controller.sync(activeExam);

  await controller.collectIfNeeded(fake.context);

  expect(dependencies.app.saveExamDraft).toHaveBeenCalledWith(
    activeExam,
    "1",
    expect.objectContaining({ answer: "Velocity changes.", confidence: 70 }),
  );
  expect(coordinator.persist).toHaveBeenCalled();
});
