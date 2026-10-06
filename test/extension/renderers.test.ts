import { expect, test, vi } from "vitest";
import extension from "../../extensions/exam-tutor/index.js";
import {
  citation,
  learnerExplanation,
  learnerSubmission,
  renderToolResult,
  toolResult,
} from "../../extensions/exam-tutor/presentation.js";
import { registerMessageRenderers } from "../../extensions/exam-tutor/renderers.js";
import {
  awaitingGrade,
  createExtensionDependencies,
  idle,
  question,
} from "./fixtures.js";
import { createFakePi } from "./fake-pi.js";

test("preserves learner transcript and citation wire formats", () => {
  expect(learnerSubmission("Velocity changes.", 70)).toBe(
    "<exam-tutor-learner-submission>\nconfidence: 70\nanswer:\nVelocity changes.\n</exam-tutor-learner-submission>",
  );
  expect(learnerExplanation("Because force changes motion.")).toBe(
    "<exam-tutor-learner-explanation>\nBecause force changes motion.\n</exam-tutor-learner-explanation>",
  );
  expect(citation(question.sourceRefs[0]!)).toBe(
    "/courses/physics/notes.md (# acceleration)",
  );
});

test("registers the learner-response renderer with its existing display modes", () => {
  const fake = createFakePi();
  registerMessageRenderers(fake.api);

  expect(fake.api.registerMessageRenderer).toHaveBeenCalledWith(
    "pi-exam-tutor/learner-response-v1",
    expect.any(Function),
  );
  expect(fake.api.registerMessageRenderer).toHaveBeenCalledWith(
    "pi-exam-tutor/exam-item-v1",
    expect.any(Function),
  );

  const renderer = fake.api.registerMessageRenderer.mock.calls.find(
    ([customType]) => customType === "pi-exam-tutor/learner-response-v1",
  )?.[1] as (
    message: {
      details?: { answer: string; confidence?: number; mode: string };
    },
    options: { expanded: boolean },
    theme: { fg(color: string, text: string): string },
  ) => { render(width: number): string[] };

  expect(
    renderer(
      {
        details: { answer: "Velocity changes.", confidence: 70, mode: "study" },
      },
      { expanded: false },
      { fg: (_color, text) => text },
    )
      .render(120)
      .join("\n")
      .trimEnd(),
  ).toBe("Your answer · confidence 70");
  expect(
    renderer(
      {
        details: { answer: "Velocity changes.", confidence: 70, mode: "study" },
      },
      { expanded: true },
      { fg: (_color, text) => text },
    )
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n"),
  ).toBe("Your answer: Velocity changes.\nConfidence: 70\nMode: study");
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

test("renders tool details before the model-facing result", () => {
  const result = toolResult("Learner display", "Model result");
  expect(
    renderToolResult(result, {}, { fg: (_color: string, text: string) => text })
      .render(120)
      .join("\n")
      .trimEnd(),
  ).toBe("Learner display");
});
