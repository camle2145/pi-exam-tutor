import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TutorApplicationService,
  type TutorApplication,
} from "./application.js";
import type { Clock, IdGenerator } from "./clock.js";
import { LocalStore } from "./storage.js";

export interface DefaultTutorDependencies {
  app: TutorApplication;
  store: LocalStore;
  clock: Clock;
}

export function createDefaultTutorDependencies(): DefaultTutorDependencies {
  const ids: IdGenerator = {
    next(prefix: string): string {
      return `${prefix}-${randomUUID()}`;
    },
  };
  const clock: Clock = { now: () => new Date() };
  const root =
    process.env.EXAM_TUTOR_HOME ??
    join(homedir(), ".pi", "agent", "exam-tutor", "v1");
  const store = new LocalStore(root, ids);
  return {
    app: new TutorApplicationService(store, clock, ids),
    store,
    clock,
  };
}
