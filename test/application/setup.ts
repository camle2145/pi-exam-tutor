import { type Course, type Question } from "../../src/domain.js";
import { TutorApplicationService } from "../../src/application.js";
import { FakeClock, SequenceIds, tempRoot } from "../helpers.js";
import { LocalStore } from "../../src/storage.js";

export const now = new Date("2026-08-27T09:00:00.000Z");

export async function createApplicationFixture(): Promise<{
  app: TutorApplicationService;
  course: Course;
  store: LocalStore;
  question: Question;
  clock: FakeClock;
}> {
  const ids = new SequenceIds();
  const store = new LocalStore(await tempRoot(), ids);
  const clock = new FakeClock(now);
  const app = new TutorApplicationService(store, clock, ids);
  const created = await app.createCourse("Physics");
  const course = await store.saveCourse(
    {
      ...created,
      revision: created.revision + 1,
      materials: [
        {
          id: "material-1",
          path: "/courses/physics/notes.md",
          addedAt: now.toISOString(),
        },
      ],
      concepts: [{ id: "kinematics", name: "Kinematics" }],
    },
    created.revision,
    "configure-course",
  );
  const question: Question = {
    id: "question-1",
    kind: "primary",
    targetConceptId: "kinematics",
    prompt: "How does acceleration affect velocity?",
    sourceRefs: [
      {
        materialId: "material-1",
        path: "/courses/physics/notes.md",
        locator: "# acceleration",
      },
    ],
  };

  return { app, course, store, question, clock };
}
