import { expect, test, vi } from "vitest";
import extension from "../../extensions/exam-tutor/index.js";
import { registerLifecycle } from "../../extensions/exam-tutor/lifecycle.js";
import {
  awaitingAnswer,
  awaitingGrade,
  createExtensionDependencies,
  idle,
} from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("exports a Pi extension factory", () => {
  expect(extension).toBeTypeOf("function");
});

test("registers its lifecycle, commands, and canonical tools", () => {
  expect(registerLifecycle).toBeTypeOf("function");
  const fake = createFakePi();
  extension(fake.api, createExtensionDependencies());

  expect(fake.commandNames()).toEqual(
    expect.arrayContaining([
      "study",
      "drill",
      "exam",
      "review",
      "dashboard",
      "hint",
      "reveal",
      "course",
      "resume-answer",
      "study-off",
    ]),
  );
  expect(fake.toolNames()).toEqual(
    expect.arrayContaining([
      "tutor_present_question",
      "tutor_present_exam",
      "tutor_present_hint",
      "tutor_record_grade",
      "tutor_present_solution",
      "tutor_record_explanation",
      "tutor_present_transfer",
      "tutor_propose_concepts",
      "tutor_record_exam_grades",
    ]),
  );
});

test("restores only the latest branch-local activity and injects its prompt", async () => {
  const dependencies = createExtensionDependencies();
  const fake = createFakePi({ activities: [idle, awaitingAnswer] });
  extension(fake.api, dependencies);

  await fake.startSession();
  const result = await fake.beforeAgentStart();

  expect(dependencies.app.restoreActivity).toHaveBeenCalledTimes(1);
  expect(dependencies.app.restoreActivity).toHaveBeenCalledWith(
    JSON.stringify(awaitingAnswer),
  );
  expect(result.systemPrompt).toContain("base prompt");
  expect(result.systemPrompt).toContain('"id":"kinematics"');
  expect(result.systemPrompt).toContain('"name":"Kinematics"');
  expect(result.systemPrompt).toContain("untrusted reference content");
  expect(result.systemPrompt).toContain("current hint level is 0");
});

test("does not inject tutor policy while activity is idle", async () => {
  const fake = createFakePi({ activity: idle });
  extension(fake.api, createExtensionDependencies());
  await fake.startSession();

  expect(await fake.beforeAgentStart()).toBeUndefined();
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
