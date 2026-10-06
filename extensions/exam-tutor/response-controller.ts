import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import type { TutorApplication } from "../../src/application.js";
import type { SessionActivity, TutorMode } from "../../src/domain.js";
import { collectResponse, type ResponsePurpose } from "./response-ui.js";
import { learnerExplanation, learnerSubmission } from "./presentation.js";
import type { SessionCoordinator } from "./runtime.js";

export interface ResponseController {
  collectIfNeeded(ctx: ExtensionContext): Promise<void>;
  resume(ctx: ExtensionContext): Promise<void>;
  hasDeferredResponse(): boolean;
  handleInput(
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<"handled" | "continue">;
  reset(): void;
}

type PendingResponse = {
  purpose: ResponsePurpose;
  activityFingerprint: string;
  draft: { answer: string; confidence?: number };
};

type ResponseControllerState = {
  panelOpen: boolean;
  deferred?: PendingResponse;
  openedFingerprint?: string;
};

export function createResponseController(
  pi: ExtensionAPI,
  coordinator: SessionCoordinator,
  app: TutorApplication,
): ResponseController {
  let state: ResponseControllerState = { panelOpen: false };

  coordinator.subscribe(() => {
    state.deferred = undefined;
    state.openedFingerprint = undefined;
  });

  const collectIfNeeded = async (
    ctx: ExtensionContext,
    draft?: PendingResponse["draft"],
  ): Promise<void> => {
    const activity = coordinator.activity();
    const details = responseDetails(activity);
    if (details === undefined) return;
    const fingerprint = activityFingerprint(activity);
    if (
      state.panelOpen ||
      state.deferred !== undefined ||
      state.openedFingerprint === fingerprint
    ) {
      return;
    }

    state.panelOpen = true;
    state.openedFingerprint = fingerprint;
    try {
      const result = await collectResponse(ctx, {
        purpose: details.purpose,
        requiresConfidence: details.requiresConfidence,
        ...(draft === undefined
          ? {}
          : { answer: draft.answer, confidence: draft.confidence }),
      });
      if (result.kind === "deferred") {
        state.deferred = {
          purpose: details.purpose,
          activityFingerprint: fingerprint,
          draft: result.draft,
        };
        coordinator.setDeferredResponse(ctx, true);
        return;
      }
      if (result.kind === "cancelled") return;

      if (details.purpose === "explanation") {
        const next = await app.recordExplanation(activity, result.answer);
        coordinator.persist(next, ctx);
        pi.sendMessage(
          {
            customType: "pi-exam-tutor/learner-response-v1",
            content: learnerExplanation(result.answer),
            display: true,
            details: { answer: result.answer, mode: details.mode },
          },
          { triggerTurn: true },
        );
        return;
      }

      const submission =
        result.confidence === undefined
          ? { answer: result.answer }
          : { answer: result.answer, confidence: result.confidence };
      const next = await app.acceptSubmission(activity, submission);
      coordinator.persist(next, ctx);
      pi.sendMessage(
        {
          customType: "pi-exam-tutor/learner-response-v1",
          content: learnerSubmission(result.answer, result.confidence),
          display: true,
          details: {
            answer: result.answer,
            ...(result.confidence === undefined
              ? {}
              : { confidence: result.confidence }),
            mode: details.mode,
          },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      state.openedFingerprint = undefined;
      if (ctx.hasUI) {
        ctx.ui.notify(
          error instanceof Error
            ? error.message
            : "Response could not be saved",
          "error",
        );
      }
    } finally {
      state.panelOpen = false;
    }
  };

  return {
    collectIfNeeded,
    async resume(ctx: ExtensionContext): Promise<void> {
      const pending = state.deferred;
      const activity = coordinator.activity();
      if (
        pending === undefined ||
        responseDetails(activity)?.purpose !== pending.purpose ||
        activityFingerprint(activity) !== pending.activityFingerprint
      ) {
        if (ctx.hasUI) ctx.ui.notify("No response is pending", "info");
        return;
      }
      state.deferred = undefined;
      state.openedFingerprint = undefined;
      coordinator.setDeferredResponse(ctx, false);
      await collectIfNeeded(ctx, pending.draft);
    },
    hasDeferredResponse: () => state.deferred !== undefined,
    async handleInput(
      event: InputEvent,
      ctx: ExtensionContext,
    ): Promise<"handled" | "continue"> {
      if (state.deferred === undefined) return "continue";
      if (ctx.hasUI) {
        ctx.ui.setEditorText(event.text);
        ctx.ui.notify(
          "Response deferred · run /resume-answer to continue",
          "info",
        );
      }
      return "handled";
    },
    reset(): void {
      state = { panelOpen: false };
    },
  };
}

function responseDetails(current: SessionActivity):
  | {
      purpose: ResponsePurpose;
      requiresConfidence: boolean;
      mode: Exclude<TutorMode, "exam">;
    }
  | undefined {
  switch (current.state.tag) {
    case "awaiting-primary-answer":
      return {
        purpose: "graded",
        requiresConfidence: true,
        mode: current.state.mode,
      };
    case "awaiting-correction":
      return {
        purpose: "correction",
        requiresConfidence: false,
        mode: current.state.mode,
      };
    case "awaiting-explanation":
      return {
        purpose: "explanation",
        requiresConfidence: false,
        mode: current.state.mode,
      };
    default:
      return undefined;
  }
}

function activityFingerprint(current: SessionActivity): string {
  const { state } = current;
  if (
    state.tag !== "awaiting-primary-answer" &&
    state.tag !== "awaiting-correction" &&
    state.tag !== "awaiting-explanation"
  ) {
    return "";
  }
  return [
    state.tag,
    state.question.id,
    "attemptId" in state ? state.attemptId : "",
    "hintLevel" in state ? state.hintLevel : "",
  ].join(":");
}
