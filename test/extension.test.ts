import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import extension from "../extensions/exam-tutor/index.js";
import {
  awaitingAnswer,
  createExtensionDependencies,
  idle,
} from "./extension/fixtures.js";
import { createFakePi } from "./extension/fake-pi.js";

test("exports a Pi extension factory", () => {
  expect(extension).toBeTypeOf("function");
});

test("documents the reusable closed-book tutor protocol", async () => {
  const [skill, protocol] = await Promise.all([
    readFile("skills/exam-tutor/SKILL.md", "utf8"),
    readFile("skills/exam-tutor/references/protocol.md", "utf8"),
  ]);

  expect(skill).toContain("name: exam-tutor");
  expect(skill).toContain("closed-book");
  expect(skill).toContain("untrusted reference content");
  expect(skill).toContain("assisted output");
  expect(protocol).toContain("Hint level 6");
  expect(protocol).toContain("/exam submit");
  expect(protocol).toContain("/reveal");
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
