import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TutorApplicationService,
  type TutorApplication,
} from "../../src/application.js";
import type { Clock, IdGenerator } from "../../src/clock.js";
import type { Course, Dashboard } from "../../src/domain.js";
import { parseAnswer } from "../../src/input.js";
import { buildTutorPrompt } from "../../src/prompt.js";
import { LocalStore, type Store } from "../../src/storage.js";
import { learnerExplanation, learnerSubmission } from "./presentation.js";
import { registerMessageRenderers } from "./renderers.js";
import { createExamController } from "./exam-controller.js";
import { createResponseController } from "./response-controller.js";
import { createSessionCoordinator } from "./runtime.js";
import { registerCommands } from "./commands.js";
import { aggregateExamSubmission, registerTools } from "./tools.js";

export { ACTIVITY_ENTRY_TYPE } from "./runtime.js";

export interface ExamTutorAdapterDependencies {
  app: TutorApplication;
  store: Store;
  clock: Clock;
  buildDashboard?: (
    course: Course,
    history: Awaited<ReturnType<Store["getHistory"]>>,
    now: Date,
  ) => Dashboard;
}

export default function examTutorExtension(
  pi: ExtensionAPI,
  suppliedDependencies?: ExamTutorAdapterDependencies,
): void {
  const dependencies = suppliedDependencies ?? defaultDependencies();
  const { app, store, clock } = dependencies;
  const coordinator = createSessionCoordinator(
    pi,
    { app, clock },
    { aggregateExamSubmission },
  );
  const responses = createResponseController(pi, coordinator, app);
  const exams = createExamController(
    pi,
    coordinator,
    app,
    clock,
    aggregateExamSubmission,
  );
  coordinator.subscribe(exams.sync);

  pi.on("session_start", async (_event, ctx) => {
    responses.reset();
    exams.reset();
    await coordinator.start(ctx);
    exams.sync(coordinator.activity());
  });

  pi.on("session_shutdown", () => {
    coordinator.shutdown();
    responses.reset();
    exams.reset();
  });

  pi.on("agent_settled", (_event, ctx) => {
    // A response can trigger the next model turn. Do not keep Pi's settled-event
    // lifecycle open while the learner interacts with its panel.
    void responses.collectIfNeeded(ctx);
    void exams.collectIfNeeded(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    if ((await responses.handleInput(event, ctx)) === "handled") {
      return { action: "handled" };
    }
    if ((await exams.handleInput(event, ctx)) === "handled") {
      return { action: "handled" };
    }
    const activity = coordinator.activity();

    if (!ctx.hasUI) {
      if (activity.state.tag === "awaiting-primary-answer") {
        const parsed = parseAnswer(event.text);
        if ("message" in parsed) {
          notifyError(ctx, parsed.message);
          return { action: "handled" };
        }
        const next = await app.acceptSubmission(activity, parsed);
        coordinator.persist(next, ctx);
        return {
          action: "transform",
          text: learnerSubmission(parsed.answer, parsed.confidence),
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }

      if (activity.state.tag === "awaiting-correction") {
        const answer = event.text.trim();
        if (answer === "") {
          notifyError(ctx, "Answer must not be empty");
          return { action: "handled" };
        }
        const next = await app.acceptSubmission(activity, { answer });
        coordinator.persist(next, ctx);
        return {
          action: "transform",
          text: learnerSubmission(answer),
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }

      if (activity.state.tag === "awaiting-explanation") {
        if (event.text.trim() === "") {
          notifyError(ctx, "Explanation must not be empty");
          return { action: "handled" };
        }
        return {
          action: "transform",
          text: learnerExplanation(event.text.trim()),
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const activity = coordinator.activity();
    if (activity.state.tag === "idle") return;
    const course = await store.getCourse(activity.state.courseId);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildTutorPrompt(course, activity.state)}`,
    };
  });

  registerCommands(pi, {
    app,
    store,
    clock,
    getActivity: coordinator.activity,
    persist: coordinator.persist,
    selectedCourseId: coordinator.selectedCourseId,
    triggerTurn: coordinator.triggerTurn,
    resumeAnswer: responses.resume,
    editExamAnswer: exams.edit,
    submitExamWithReview: exams.submitWithReview,
    dashboardBuilder: dependencies.buildDashboard,
  });
  registerMessageRenderers(pi);
  registerTools(pi, {
    app,
    getActivity: coordinator.activity,
    persist: coordinator.persist,
    showExamItem: exams.showActiveItem,
  });
}

function notifyError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function defaultDependencies(): ExamTutorAdapterDependencies {
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
