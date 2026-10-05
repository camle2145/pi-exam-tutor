import { expect, test } from "vitest";
import { createApplicationFixture, now } from "./setup.js";

async function activeExamFor() {
  const { app, course, question, store } = await createApplicationFixture();
  const active = await app.recordExam(
    await app.requestMode(course.id, "exam"),
    {
      id: "exam-1",
      operationId: "exam-operation-1",
      startedAt: now.toISOString(),
      status: "active",
      items: [{ ...question, id: "exam-question-1", kind: "exam" }],
      drafts: {},
    },
  );
  return { active, app, course, store };
}

test("saves an exam draft through the application facade without history writes", async () => {
  const { active, app, course, store } = await activeExamFor();

  const next = await app.saveExamDraft(active, "exam-question-1", {
    answer: "Acceleration changes velocity.",
    confidence: 70,
    submittedAt: now.toISOString(),
  });

  expect(next.state).toMatchObject({
    tag: "exam-active",
    exam: { drafts: { "exam-question-1": { confidence: 70 } } },
  });
  expect((await store.getHistory(course.id)).attempts).toEqual([]);
});
