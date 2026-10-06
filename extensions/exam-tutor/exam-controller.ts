import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { TutorApplication } from "../../src/application.js";
import type { Clock } from "../../src/clock.js";
import type { SessionActivity } from "../../src/domain.js";
import { parseExamDraft } from "../../src/input.js";
import { collectResponse } from "./response-ui.js";
import type { SessionCoordinator } from "./runtime.js";

export interface ExamController {
  sync(activity: SessionActivity): void;
  collectIfNeeded(ctx: ExtensionContext): Promise<void>;
  edit(ctx: ExtensionContext, questionId: string): Promise<void>;
  submitWithReview(ctx: ExtensionContext): Promise<void>;
  showActiveItem(ctx: ExtensionContext): void;
  handleInput(
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<"handled" | "continue">;
  reset(): void;
}

interface ExamControllerState {
  activeQuestionId?: string;
  deferredDraft?: {
    questionId: string;
    answer: string;
    confidence?: number;
  };
  pendingEdit?: {
    questionId: string;
    answer: string;
    previousConfidence: number;
  };
}

const EXAM_REVIEW_OVERLAY = {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center" as const,
    width: "70%" as const,
    maxHeight: "50%" as const,
    margin: 1,
  },
};

class ExamReviewPanel extends Container {
  constructor(
    text: string,
    theme: Theme,
    private readonly done: (confirmed: boolean) => void,
  ) {
    super();
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Exam review")), 1, 1),
    );
    this.addChild(new Text(theme.fg("text", text), 1, 0));
    this.addChild(
      new Text(theme.fg("dim", "Enter choose action • Esc cancel"), 1, 0),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) this.done(true);
    if (matchesKey(data, "escape")) this.done(false);
  }
}

export function createExamController(
  pi: ExtensionAPI,
  coordinator: SessionCoordinator,
  app: TutorApplication,
  clock: Clock,
  aggregateExamSubmission: (activity: SessionActivity) => string,
): ExamController {
  let state: ExamControllerState = {};
  let panelOpen = false;
  let openedQuestionId: string | undefined;

  const sync = (activity: SessionActivity): void => {
    if (activity.state.tag !== "exam-active") {
      state = {};
      openedQuestionId = undefined;
      return;
    }
    const { exam } = activity.state;
    const activeQuestionId = exam.items.find(
      ({ id }) => !Object.hasOwn(exam.drafts, id),
    )?.id;
    if (state.activeQuestionId !== activeQuestionId) {
      openedQuestionId = undefined;
    }
    state = {
      activeQuestionId,
      ...(state.deferredDraft === undefined
        ? {}
        : { deferredDraft: state.deferredDraft }),
      ...(state.pendingEdit === undefined
        ? {}
        : { pendingEdit: state.pendingEdit }),
    };
  };

  const showActiveItem = (ctx: ExtensionContext): void => {
    const activity = coordinator.activity();
    if (activity.state.tag !== "exam-active") return;
    const { exam } = activity.state;
    const item = exam.items.find(({ id }) => id === state.activeQuestionId);
    if (item === undefined) {
      pi.sendMessage(
        {
          customType: "pi-exam-tutor/exam-item-v1",
          content: "Review & Submit\nAll answers are saved.",
          display: true,
          details: {
            progress: "Review & Submit",
            prompt: "All answers are saved.",
          },
        },
        { triggerTurn: false },
      );
      return;
    }
    const progress = `Question ${exam.items.findIndex(({ id }) => id === item.id) + 1} of ${exam.items.length}`;
    pi.sendMessage(
      {
        customType: "pi-exam-tutor/exam-item-v1",
        content: `${progress}\n${item.prompt}`,
        display: true,
        details: { progress, prompt: item.prompt },
      },
      { triggerTurn: false },
    );
  };

  const collect = async (
    ctx: ExtensionContext,
    questionId = state.activeQuestionId,
    edit?: { answer: string; confidence: number },
  ): Promise<void> => {
    const activity = coordinator.activity();
    if (activity.state.tag !== "exam-active" || questionId === undefined) {
      return;
    }
    const item = activity.state.exam.items.find(({ id }) => id === questionId);
    if (item === undefined || panelOpen || state.pendingEdit !== undefined) {
      return;
    }
    if (edit === undefined && openedQuestionId === questionId) return;

    const persistedDraft = activity.state.exam.drafts[questionId];
    const deferredDraft =
      state.deferredDraft?.questionId === questionId
        ? state.deferredDraft
        : undefined;
    const initial = edit ?? deferredDraft ?? persistedDraft;
    panelOpen = true;
    openedQuestionId = questionId;
    try {
      const result = await collectResponse(ctx, {
        purpose: "exam",
        requiresConfidence: true,
        ...(initial === undefined
          ? {}
          : { answer: initial.answer, confidence: initial.confidence }),
      });
      if (result.kind === "cancelled") {
        if (persistedDraft === undefined) openedQuestionId = undefined;
        return;
      }
      if (result.kind === "deferred") {
        if (persistedDraft !== undefined) {
          state = {
            ...state,
            pendingEdit: {
              questionId,
              answer: result.draft.answer,
              previousConfidence: persistedDraft.confidence,
            },
          };
          coordinator.setDeferredResponse(ctx, false);
        } else {
          state = {
            ...state,
            deferredDraft: { questionId, ...result.draft },
          };
          openedQuestionId = undefined;
        }
        return;
      }
      if (result.confidence === undefined) {
        openedQuestionId = undefined;
        return;
      }

      state = { ...state, deferredDraft: undefined };
      const next = await app.saveExamDraft(activity, questionId, {
        answer: result.answer,
        confidence: result.confidence,
        submittedAt: clock.now().toISOString(),
      });
      coordinator.persist(next, ctx);
      showActiveItem(ctx);
    } catch (error) {
      openedQuestionId = undefined;
      notifyError(
        ctx,
        error instanceof Error
          ? error.message
          : "Exam answer could not be saved",
      );
    } finally {
      panelOpen = false;
    }
  };

  const edit = async (
    ctx: ExtensionContext,
    rawQuestionId: string,
  ): Promise<void> => {
    const activity = coordinator.activity();
    if (activity.state.tag !== "exam-active") {
      notifyError(ctx, "There is no active exam to edit");
      return;
    }
    let questionId = rawQuestionId.trim();
    if (questionId === "" && ctx.hasUI) {
      questionId =
        (await ctx.ui.select(
          "Exam item to edit",
          activity.state.exam.items.map(({ id }) => id),
        )) ?? "";
    }
    const draft = activity.state.exam.drafts[questionId];
    if (draft === undefined) {
      notifyError(ctx, "Only saved exam answers can be edited");
      return;
    }
    state = { ...state, pendingEdit: undefined };
    openedQuestionId = undefined;
    await collect(ctx, questionId, draft);
  };

  const showReview = async (ctx: ExtensionContext): Promise<boolean> => {
    const activity = coordinator.activity();
    if (activity.state.tag !== "exam-active" || !ctx.hasUI) return false;
    const { exam } = activity.state;
    const text = exam.items
      .map(({ id }) => {
        const status =
          state.pendingEdit?.questionId === id
            ? "Confidence reconfirmation pending"
            : Object.hasOwn(exam.drafts, id)
              ? "Answered"
              : "Unanswered";
        return `${id}: ${status}`;
      })
      .join("\n");
    const reviewed = await ctx.ui.custom<boolean>(
      (_tui, theme, _keybindings, done) =>
        new ExamReviewPanel(text, theme, (confirmed) => done(confirmed)),
      EXAM_REVIEW_OVERLAY,
    );
    if (reviewed !== true) return false;
    const action = await ctx.ui.select("Exam review action", [
      "submit",
      ...exam.items
        .filter(({ id }) => Object.hasOwn(exam.drafts, id))
        .map(({ id }) => `edit ${id}`),
      "cancel",
    ]);
    if (action === "submit") return true;
    if (action?.startsWith("edit ")) {
      await edit(ctx, action.slice("edit ".length));
    }
    return false;
  };

  return {
    sync,
    collectIfNeeded: (ctx) => collect(ctx),
    edit,
    async submitWithReview(ctx: ExtensionContext): Promise<void> {
      if (state.pendingEdit !== undefined) {
        if (!ctx.hasUI) return;
        const action = await ctx.ui.select("Resolve pending edit", [
          "resume",
          "discard",
        ]);
        if (action === "resume") {
          const pending = state.pendingEdit;
          state = { ...state, pendingEdit: undefined };
          openedQuestionId = undefined;
          await collect(ctx, pending.questionId, {
            answer: pending.answer,
            confidence: pending.previousConfidence,
          });
          return;
        }
        if (action !== "discard") return;
        state = { ...state, pendingEdit: undefined };
      }
      if (!(await showReview(ctx))) return;
      const next = await app.submitExam(coordinator.activity());
      coordinator.persist(next, ctx);
      coordinator.triggerTurn(aggregateExamSubmission(next));
    },
    showActiveItem,
    async handleInput(
      event: InputEvent,
      ctx: ExtensionContext,
    ): Promise<"handled" | "continue"> {
      const activity = coordinator.activity();
      if (activity.state.tag !== "exam-active") return "continue";
      if (ctx.hasUI) return "handled";
      const parsed = parseExamDraft(
        event.text,
        activity.state.exam.items.map(({ id }) => id),
      );
      if ("message" in parsed) {
        notifyError(ctx, parsed.message);
        return "handled";
      }
      let next = activity;
      const submittedAt = clock.now().toISOString();
      for (const [questionId, draft] of Object.entries(parsed.drafts)) {
        next = await app.saveExamDraft(next, questionId, {
          ...draft,
          submittedAt,
        });
      }
      coordinator.persist(next, ctx);
      return "handled";
    },
    reset(): void {
      state = {};
      panelOpen = false;
      openedQuestionId = undefined;
    },
  };
}

function notifyError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}
