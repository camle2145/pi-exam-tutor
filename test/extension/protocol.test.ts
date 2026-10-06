import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

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
