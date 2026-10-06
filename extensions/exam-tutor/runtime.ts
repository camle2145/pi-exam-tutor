import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TutorApplication } from "../../src/application.js";
import type { Clock } from "../../src/clock.js";
import type { SessionActivity } from "../../src/domain.js";
import { setDeferredResponseWidget, updateTutorStatus } from "../../src/ui.js";

export const ACTIVITY_ENTRY_TYPE = "pi-exam-tutor/activity-v1";

export interface SessionCoordinator {
  activity(): SessionActivity;
  persist(next: SessionActivity, ctx: ExtensionContext): void;
  selectedCourseId(): string;
  triggerTurn(instruction: string): void;
  start(ctx: ExtensionContext): Promise<void>;
  shutdown(): void;
  subscribe(listener: (activity: SessionActivity) => void): () => void;
  setDeferredResponse(ctx: ExtensionContext, deferred: boolean): void;
}

export interface SessionCoordinatorCallbacks {
  aggregateExamSubmission(activity: SessionActivity): string;
}

export function createSessionCoordinator(
  pi: ExtensionAPI,
  dependencies: { app: TutorApplication; clock: Clock },
  callbacks: SessionCoordinatorCallbacks,
): SessionCoordinator {
  const { app, clock } = dependencies;
  let currentActivity = idleActivity();
  let deadlineTimer: NodeJS.Timeout | undefined;
  const listeners = new Set<(activity: SessionActivity) => void>();

  const triggerTurn = (instruction: string): void => {
    pi.sendMessage(
      {
        customType: "pi-exam-tutor/turn-v1",
        content: instruction,
        display: false,
      },
      { triggerTurn: true },
    );
  };

  const notifyDeadlineError = (ctx: ExtensionContext, error: unknown): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(
        error instanceof Error
          ? error.message
          : "Exam deadline submission failed",
        "error",
      );
    }
  };

  const scheduleDeadline = (
    next: SessionActivity,
    ctx: ExtensionContext,
  ): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    if (
      next.state.tag !== "exam-active" ||
      next.state.exam.deadlineAt === undefined
    ) {
      return;
    }

    const examId = next.state.exam.id;
    const delay = Math.max(
      0,
      new Date(next.state.exam.deadlineAt).getTime() -
        clock.now().getTime() +
        1,
    );
    deadlineTimer = setTimeout(async () => {
      if (
        currentActivity.state.tag !== "exam-active" ||
        currentActivity.state.exam.id !== examId
      ) {
        return;
      }
      try {
        const submitted = await app.submitExam(currentActivity);
        persist(submitted, ctx);
        triggerTurn(callbacks.aggregateExamSubmission(submitted));
      } catch (error) {
        notifyDeadlineError(ctx, error);
      }
    }, delay);
    deadlineTimer.unref();
  };

  const notifyActivityChanged = (next: SessionActivity): void => {
    for (const listener of listeners) listener(next);
  };

  const persist = (next: SessionActivity, ctx: ExtensionContext): void => {
    currentActivity = next;
    pi.appendEntry(ACTIVITY_ENTRY_TYPE, next);
    updateTutorStatus(ctx, next);
    scheduleDeadline(next, ctx);
    notifyActivityChanged(next);
  };

  return {
    activity: () => currentActivity,
    persist,
    selectedCourseId: () => {
      const courseId = currentActivity.state.courseId;
      if (courseId === undefined) {
        throw new Error(
          "Select a course with /course before starting tutor mode",
        );
      }
      return courseId;
    },
    triggerTurn,
    async start(ctx: ExtensionContext): Promise<void> {
      let latestData: unknown;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "custom" &&
          entry.customType === ACTIVITY_ENTRY_TYPE
        ) {
          latestData = entry.data;
        }
      }
      currentActivity =
        latestData === undefined
          ? idleActivity()
          : app.restoreActivity(JSON.stringify(latestData));
      updateTutorStatus(ctx, currentActivity);
      scheduleDeadline(currentActivity, ctx);
      notifyActivityChanged(currentActivity);
    },
    shutdown(): void {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    },
    subscribe(listener: (activity: SessionActivity) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDeferredResponse(ctx: ExtensionContext, deferred: boolean): void {
      updateTutorStatus(ctx, currentActivity);
      setDeferredResponseWidget(ctx, deferred);
    },
  };
}

function idleActivity(courseId?: string): SessionActivity {
  return {
    schemaVersion: 1,
    state: { tag: "idle", ...(courseId === undefined ? {} : { courseId }) },
  };
}
