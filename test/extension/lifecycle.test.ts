import { expect, test } from "vitest";
import extension from "../../extensions/exam-tutor/index.js";
import { createExtensionDependencies } from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("registers every required tutor command and canonical tool", () => {
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
