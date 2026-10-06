import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseAnswer } from "../../src/input.js";
import { buildTutorPrompt } from "../../src/prompt.js";
import { learnerExplanation, learnerSubmission } from "./presentation.js";
import type { ExamTutorAdapterDependencies } from "./index.js";
import type { ExamController } from "./exam-controller.js";
import type { ResponseController } from "./response-controller.js";
import type { SessionCoordinator } from "./runtime.js";

export function registerLifecycle(
  pi: ExtensionAPI,
  coordinator: SessionCoordinator,
  responses: ResponseController,
  exams: ExamController,
  dependencies: ExamTutorAdapterDependencies,
): void {
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
        const next = await dependencies.app.acceptSubmission(activity, parsed);
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
        const next = await dependencies.app.acceptSubmission(activity, {
          answer,
        });
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
    const course = await dependencies.store.getCourse(activity.state.courseId);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildTutorPrompt(course, activity.state)}`,
    };
  });
}

function notifyError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}
