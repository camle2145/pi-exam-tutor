import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TutorApplication } from "../../src/application.js";
import type { Clock } from "../../src/clock.js";
import { buildDashboard as projectDashboard } from "../../src/dashboard.js";
import type {
  Course,
  Dashboard,
  LearningHistory,
  SessionActivity,
  TutorMode,
} from "../../src/domain.js";
import type { CourseController } from "./course-controller.js";
import { showDashboard } from "./ui.js";

export interface CommandDependencies {
  app: TutorApplication;
  store: {
    listCourses(): Promise<Course[]>;
    getCourse(courseId: string): Promise<Course>;
    getHistory(courseId: string): Promise<LearningHistory>;
  };
  clock: Clock;
  getActivity(): SessionActivity;
  persist(next: SessionActivity, ctx: ExtensionContext): void;
  selectedCourseId(): string;
  triggerTurn(instruction: string): void;
  resumeAnswer(ctx: ExtensionContext): Promise<void>;
  editExamAnswer(ctx: ExtensionContext, questionId: string): Promise<void>;
  submitExamWithReview(ctx: ExtensionContext): Promise<void>;
  dashboardBuilder?: (
    course: Course,
    history: LearningHistory,
    now: Date,
  ) => Dashboard;
  courses: CourseController;
}

export function splitCommand(args: string): { action: string; value: string } {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { action: match?.[1] ?? "", value: match?.[2] ?? "" };
}

export function registerCommands(
  pi: ExtensionAPI,
  dependencies: CommandDependencies,
): void {
  const dashboardBuilder = dependencies.dashboardBuilder ?? projectDashboard;

  const requestMode = async (
    mode: TutorMode,
    args: string,
    ctx: ExtensionCommandContext,
    deadlineAt?: string,
  ): Promise<void> => {
    assertExamUnlocked(dependencies.getActivity());
    const next = await dependencies.app.requestMode(
      dependencies.selectedCourseId(),
      mode,
      deadlineAt === undefined ? {} : { deadlineAt },
    );
    dependencies.persist(next, ctx);
    const requested = args.trim();
    dependencies.triggerTurn(
      requested === ""
        ? `Begin ${mode} mode using the canonical tutor workflow.`
        : `Begin ${mode} mode. Requested concept IDs: ${requested}.`,
    );
  };

  pi.registerCommand("course", {
    description: "Create, select, or add material to an exam-tutor course",
    handler: async (args, ctx) => {
      assertExamUnlocked(dependencies.getActivity());
      const { action, value } = splitCommand(args);
      await dependencies.courses.handle(action, value, ctx);
    },
  });
  pi.registerCommand("study", {
    description: "Start closed-book study",
    handler: (args, ctx) => requestMode("study", args, ctx),
  });
  pi.registerCommand("drill", {
    description: "Start interleaved drill",
    handler: (args, ctx) => requestMode("drill", args, ctx),
  });
  pi.registerCommand("review", {
    description: "Review due questions",
    handler: (args, ctx) => requestMode("review", args, ctx),
  });
  pi.registerCommand("exam", {
    description: "Start or submit a feedback-isolated exam",
    handler: async (args, ctx) => {
      const { action, value } = splitCommand(args);
      if (action === "submit" && value.trim() === "") {
        await dependencies.submitExamWithReview(ctx);
        return;
      }
      if (action === "edit") {
        await dependencies.editExamAnswer(ctx, value);
        return;
      }
      assertExamUnlocked(dependencies.getActivity());
      const text = args.trim();
      let deadlineAt: string | undefined;
      if (text !== "") {
        const minutes = Number(text);
        if (!Number.isInteger(minutes) || minutes <= 0) {
          notifyError(ctx, "Exam minutes must be a positive integer");
          return;
        }
        deadlineAt = new Date(
          dependencies.clock.now().getTime() + minutes * 60_000,
        ).toISOString();
      }
      await requestMode("exam", "", ctx, deadlineAt);
    },
  });
  pi.registerCommand("hint", {
    description: "Request exactly the next hint level",
    handler: async (_args, ctx) => {
      assertExamUnlocked(dependencies.getActivity());
      const next = await dependencies.app.requestHint(
        dependencies.getActivity(),
      );
      dependencies.persist(next, ctx);
      dependencies.triggerTurn("Present exactly the requested hint level.");
    },
  });
  pi.registerCommand("reveal", {
    description: "Request a solution followed by explanation and transfer",
    handler: async (_args, ctx) => {
      assertExamUnlocked(dependencies.getActivity());
      const next = await dependencies.app.requestReveal(
        dependencies.getActivity(),
      );
      dependencies.persist(next, ctx);
      dependencies.triggerTurn(
        "Present the solution through the canonical tool.",
      );
    },
  });
  pi.registerCommand("dashboard", {
    description: "Show local learning evidence",
    handler: async (_args, ctx) => {
      assertExamUnlocked(dependencies.getActivity());
      const courseId = dependencies.selectedCourseId();
      const [course, history] = await Promise.all([
        dependencies.store.getCourse(courseId),
        dependencies.store.getHistory(courseId),
      ]);
      await showDashboard(
        pi,
        ctx,
        course,
        dashboardBuilder(course, history, dependencies.clock.now()),
      );
    },
  });
  pi.registerCommand("resume-answer", {
    description: "Resume a deferred tutor response",
    handler: async (_args, ctx) => dependencies.resumeAnswer(ctx),
  });
  pi.registerCommand("study-off", {
    description: "Turn off tutor mode",
    handler: async (_args, ctx) => {
      assertExamUnlocked(dependencies.getActivity());
      dependencies.persist(
        idleActivity(dependencies.getActivity().state.courseId),
        ctx,
      );
    },
  });
}

function assertExamUnlocked(current: SessionActivity): void {
  if (current.state.tag === "exam-active") {
    throw new Error(
      "Finish the active exam with /exam submit or wait for its deadline",
    );
  }
}

function idleActivity(courseId?: string): SessionActivity {
  return {
    schemaVersion: 1,
    state: { tag: "idle", ...(courseId === undefined ? {} : { courseId }) },
  };
}

function notifyError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}
