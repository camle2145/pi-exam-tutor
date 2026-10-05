import type { Clock, IdGenerator } from "../clock.js";
import type { ActivityState, Course, SessionActivity } from "../domain.js";
import type { Scheduler } from "../scheduler.js";
import type { Store } from "../storage.js";
import { ActivityCodec } from "./activity-codec.js";

export class ApplicationRuntime {
  constructor(
    readonly store: Store,
    readonly clock: Clock,
    readonly ids: IdGenerator,
    readonly scheduler: Scheduler,
    readonly codec: ActivityCodec,
  ) {}

  activity(state: ActivityState): SessionActivity {
    return { schemaVersion: 1, state };
  }

  async courseFor(current: SessionActivity): Promise<Course> {
    this.codec.assert(current);
    const courseId = current.state.courseId;
    if (courseId === undefined) {
      throw new Error("An activity must select a course");
    }
    return this.store.getCourse(courseId);
  }

  operationId(): string {
    return this.ids.next("operation");
  }
}
