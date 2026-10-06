import { expect, test, vi } from "vitest";
import extension from "../../extensions/exam-tutor/index.js";
import { createResponseController } from "../../extensions/exam-tutor/response-controller.js";
import type { SessionCoordinator } from "../../extensions/exam-tutor/runtime.js";
import type { SessionActivity } from "../../src/domain.js";
import {
  awaitingAnswer,
  awaitingGrade,
  course,
  createExtensionDependencies,
  question,
} from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("opens one response panel after the tutor turn settles", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  await fake.agentSettled();
  await fake.agentSettled();

  expect(fake.ui.custom).toHaveBeenCalledTimes(1);
});

test("settles before an interactive response panel is completed", async () => {
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const fake = createFakePi({ activity: awaitingAnswer });
  let resolvePanel!: (result: unknown) => void;
  fake.ui.custom.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePanel = resolve;
      }),
  );
  extension(fake.api, createExtensionDependencies({ acceptSubmission }));
  await fake.startSession();

  const settled = fake.agentSettled();
  await expect(
    Promise.race([
      settled.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 20),
      ),
    ]),
  ).resolves.toBe("settled");

  resolvePanel({
    kind: "submitted",
    answer: "Velocity changes.",
    confidence: 70,
  });
  await vi.waitFor(() => {
    expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
      answer: "Velocity changes.",
      confidence: 70,
    });
  });
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({ options: { triggerTurn: true } }),
  );
});

test("persists and sends a confirmed answer as a custom learner message", async () => {
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const dependencies = createExtensionDependencies({ acceptSubmission });
  const fake = createFakePi({ activity: awaitingAnswer });
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "Velocity changes.",
    confidence: 70,
  });
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.agentSettled();

  await vi.waitFor(() => {
    expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
      answer: "Velocity changes.",
      confidence: 70,
    });
  });
  expect(fake.sentMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        customType: "pi-exam-tutor/learner-response-v1",
        content: expect.stringContaining("<exam-tutor-learner-submission>"),
        display: true,
      }),
      options: { triggerTurn: true },
    }),
  );
});

test("defers without persistence and restores ordinary typed text", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  fake.ui.custom.mockResolvedValueOnce({
    kind: "deferred",
    draft: { answer: "x" },
  });
  const dependencies = createExtensionDependencies();
  extension(fake.api, dependencies);
  await fake.startSession();

  await fake.agentSettled();

  await expect(fake.dispatchInput("do not lose this")).resolves.toEqual({
    action: "handled",
  });
  expect(dependencies.app.acceptSubmission).not.toHaveBeenCalled();
  expect(fake.ui.setEditorText).toHaveBeenCalledWith("do not lose this");
  expect(fake.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("/resume-answer"),
    "info",
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

test("retains header parsing for regular answers without a UI", async () => {
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const fake = createFakePi({ activity: awaitingAnswer, mode: "print" });
  extension(fake.api, createExtensionDependencies({ acceptSubmission }));
  await fake.startSession();

  await expect(
    fake.dispatchInput("[confidence: 70]\nVelocity changes over time."),
  ).resolves.toMatchObject({
    action: "transform",
    text: expect.stringContaining("<exam-tutor-learner-submission>"),
  });
  expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
    answer: "Velocity changes over time.",
    confidence: 70,
  });
});

test("collects a correction without confidence", async () => {
  const correction = {
    ...awaitingAnswer,
    state: {
      tag: "awaiting-correction" as const,
      courseId: course.id,
      mode: "study" as const,
      attemptId: "attempt-1",
      question,
      hintLevel: 0 as const,
    },
  } satisfies SessionActivity;
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const fake = createFakePi({ activity: correction });
  fake.ui.custom.mockResolvedValueOnce({
    kind: "submitted",
    answer: "Corrected answer.",
  });
  extension(fake.api, createExtensionDependencies({ acceptSubmission }));
  await fake.startSession();

  await fake.agentSettled();

  expect(acceptSubmission).toHaveBeenCalledWith(correction, {
    answer: "Corrected answer.",
  });
});

test("does not persist a deferred response until it is resumed and submitted", async () => {
  const fake = createFakePi();
  const dependencies = createExtensionDependencies({
    acceptSubmission: vi.fn(async () => awaitingGrade),
  });
  const coordinator = {
    activity: () => awaitingAnswer,
    persist: vi.fn(),
    triggerTurn: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    setDeferredResponse: vi.fn(),
  } as unknown as SessionCoordinator;
  const controller = createResponseController(
    fake.api,
    coordinator,
    dependencies.app,
  );
  fake.ui.custom
    .mockResolvedValueOnce({ kind: "deferred", draft: { answer: "draft" } })
    .mockResolvedValueOnce({
      kind: "submitted",
      answer: "draft",
      confidence: 60,
    });

  await controller.collectIfNeeded(fake.context);
  expect(coordinator.persist).not.toHaveBeenCalled();

  await controller.resume(fake.context);
  expect(coordinator.persist).toHaveBeenCalledWith(awaitingGrade, fake.context);
});
