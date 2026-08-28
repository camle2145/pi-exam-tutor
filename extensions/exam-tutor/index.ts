import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  TutorApplicationService,
  type TutorApplication,
} from "../../src/application.js";
import type { Clock, IdGenerator } from "../../src/clock.js";
import { buildDashboard as projectDashboard } from "../../src/dashboard.js";
import type {
  ActivityState,
  Course,
  Dashboard,
  ExamSession,
  HintLevel,
  Question,
  SessionActivity,
  SourceReference,
  TutorMode,
} from "../../src/domain.js";
import { parseAnswer, parseExamDraft } from "../../src/input.js";
import { buildTutorPrompt } from "../../src/prompt.js";
import { LocalStore, type Store } from "../../src/storage.js";
import { transition } from "../../src/state-machine.js";
import { showDashboard, updateTutorStatus } from "../../src/ui.js";

export const ACTIVITY_ENTRY_TYPE = "pi-exam-tutor/activity-v1";

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

const sourceReferenceSchema = Type.Object({
  materialId: Type.String(),
  path: Type.String(),
  locator: Type.String(),
});
const questionSchema = Type.Object({
  id: Type.String(),
  kind: StringEnum(["primary", "transfer", "exam"] as const),
  targetConceptId: Type.String(),
  prompt: Type.String(),
  sourceRefs: Type.Array(sourceReferenceSchema, { minItems: 1 }),
});
type ToolDisplayDetails = {
  display: string;
};

export default function examTutorExtension(
  pi: ExtensionAPI,
  suppliedDependencies?: ExamTutorAdapterDependencies,
): void {
  const dependencies = suppliedDependencies ?? defaultDependencies();
  const { app, store, clock } = dependencies;
  const dashboardBuilder = dependencies.buildDashboard ?? projectDashboard;
  let activity: SessionActivity = idleActivity();
  let deadlineTimer: NodeJS.Timeout | undefined;

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
        activity.state.tag !== "exam-active" ||
        activity.state.exam.id !== examId
      ) {
        return;
      }
      try {
        const submitted = await app.submitExam(activity);
        persist(submitted, ctx);
        triggerTurn("Grade the expired exam as one aggregate submission.");
      } catch (error) {
        notifyError(
          ctx,
          error instanceof Error
            ? error.message
            : "Exam deadline submission failed",
        );
      }
    }, delay);
    deadlineTimer.unref();
  };

  const persist = (next: SessionActivity, ctx: ExtensionContext): void => {
    activity = next;
    pi.appendEntry(ACTIVITY_ENTRY_TYPE, next);
    updateTutorStatus(ctx, next);
    scheduleDeadline(next, ctx);
  };

  const selectedCourseId = (): string => {
    const courseId = activity.state.courseId;
    if (courseId === undefined) {
      throw new Error(
        "Select a course with /course before starting tutor mode",
      );
    }
    return courseId;
  };

  pi.on("session_start", async (_event, ctx) => {
    let latestData: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ACTIVITY_ENTRY_TYPE) {
        latestData = entry.data;
      }
    }
    activity =
      latestData === undefined
        ? idleActivity()
        : app.restoreActivity(JSON.stringify(latestData));
    updateTutorStatus(ctx, activity);
    scheduleDeadline(activity, ctx);
  });

  pi.on("session_shutdown", () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    if (activity.state.tag === "exam-active") {
      const parsed = parseExamDraft(
        event.text,
        activity.state.exam.items.map(({ id }) => id),
      );
      if ("message" in parsed) {
        notifyError(ctx, parsed.message);
        return { action: "handled" };
      }

      let state: ActivityState = activity.state;
      const submittedAt = clock.now().toISOString();
      for (const [questionId, draft] of Object.entries(parsed.drafts)) {
        state = transition(state, {
          type: "examDraftAccepted",
          questionId,
          draft: { ...draft, submittedAt },
        });
      }
      persist({ schemaVersion: 1, state }, ctx);
      if (ctx.hasUI) ctx.ui.notify("Exam draft saved locally", "info");
      return { action: "handled" };
    }

    if (
      activity.state.tag === "awaiting-primary-answer" ||
      activity.state.tag === "awaiting-correction"
    ) {
      const parsed = parseAnswer(event.text);
      if ("message" in parsed) {
        notifyError(ctx, parsed.message);
        return { action: "handled" };
      }
      const next = await app.acceptSubmission(activity, parsed);
      persist(next, ctx);
      return {
        action: "transform",
        text: learnerSubmission(parsed.answer, parsed.confidence),
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

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
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
    getActivity: () => activity,
    persist,
    selectedCourseId,
    triggerTurn,
    dashboardBuilder,
  });
  registerTools(pi, app, () => activity, persist);
}

interface CommandRuntime {
  app: TutorApplication;
  store: Store;
  clock: Clock;
  getActivity(): SessionActivity;
  persist(next: SessionActivity, ctx: ExtensionContext): void;
  selectedCourseId(): string;
  triggerTurn(instruction: string): void;
  dashboardBuilder: (
    course: Course,
    history: Awaited<ReturnType<Store["getHistory"]>>,
    now: Date,
  ) => Dashboard;
}

function registerCommands(pi: ExtensionAPI, runtime: CommandRuntime): void {
  const requestMode = async (
    mode: TutorMode,
    args: string,
    ctx: ExtensionCommandContext,
    deadlineAt?: string,
  ): Promise<void> => {
    const next = await runtime.app.requestMode(
      runtime.selectedCourseId(),
      mode,
      deadlineAt === undefined ? {} : { deadlineAt },
    );
    runtime.persist(next, ctx);
    const requested = args.trim();
    runtime.triggerTurn(
      requested === ""
        ? `Begin ${mode} mode using the canonical tutor workflow.`
        : `Begin ${mode} mode. Requested concept IDs: ${requested}.`,
    );
  };

  pi.registerCommand("course", {
    description: "Create, select, or add material to an exam-tutor course",
    handler: async (args, ctx) => {
      const parsed = splitCommand(args);
      let action = parsed.action;
      let value = parsed.value;
      if (action === "" && ctx.mode === "tui") {
        action =
          (await ctx.ui.select("Course action", ["create", "select", "add"])) ??
          "";
      }
      if (action === "create") {
        const requestedValue = await commandValue(ctx, value, "Course name");
        if (requestedValue === undefined) return;
        const created = await runtime.app.createCourse(unquote(requestedValue));
        const selected = await runtime.app.selectCourse(
          created.id,
          runtime.getActivity(),
        );
        runtime.persist(selected, ctx);
        return;
      }
      if (action === "select") {
        if (value.trim() === "" && ctx.mode === "tui") {
          const courses = await runtime.store.listCourses();
          value =
            (await ctx.ui.select(
              "Select course",
              courses.map(({ id, name }) => `${id} — ${name}`),
            )) ?? "";
          value = value.split(" — ")[0] ?? "";
        }
        if (value.trim() === "") {
          notifyError(ctx, "Usage: /course select <course-id>");
          return;
        }
        const selected = await runtime.app.selectCourse(
          value.trim(),
          runtime.getActivity(),
        );
        runtime.persist(selected, ctx);
        return;
      }
      if (action === "add") {
        const requestedValue = await commandValue(
          ctx,
          value,
          "Absolute material path",
        );
        if (requestedValue === undefined) return;
        await runtime.app.addMaterial(
          runtime.selectedCourseId(),
          unquote(requestedValue),
        );
        if (ctx.hasUI) ctx.ui.notify("Course material added", "info");
        return;
      }
      notifyError(
        ctx,
        "Usage: /course create <name> | select <course-id> | add <absolute-path>",
      );
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
      if (args.trim() === "submit") {
        const next = await runtime.app.submitExam(runtime.getActivity());
        runtime.persist(next, ctx);
        runtime.triggerTurn(
          "Grade the submitted exam as one aggregate submission.",
        );
        return;
      }
      const text = args.trim();
      let deadlineAt: string | undefined;
      if (text !== "") {
        const minutes = Number(text);
        if (!Number.isInteger(minutes) || minutes <= 0) {
          notifyError(ctx, "Exam minutes must be a positive integer");
          return;
        }
        deadlineAt = new Date(
          runtime.clock.now().getTime() + minutes * 60_000,
        ).toISOString();
      }
      await requestMode("exam", "", ctx, deadlineAt);
    },
  });
  pi.registerCommand("hint", {
    description: "Request exactly the next hint level",
    handler: async (_args, ctx) => {
      const next = await runtime.app.requestHint(runtime.getActivity());
      runtime.persist(next, ctx);
      runtime.triggerTurn("Present exactly the requested hint level.");
    },
  });
  pi.registerCommand("reveal", {
    description: "Request a solution followed by explanation and transfer",
    handler: async (_args, ctx) => {
      const next = await runtime.app.requestReveal(runtime.getActivity());
      runtime.persist(next, ctx);
      runtime.triggerTurn("Present the solution through the canonical tool.");
    },
  });
  pi.registerCommand("dashboard", {
    description: "Show local learning evidence",
    handler: async (_args, ctx) => {
      const courseId = runtime.selectedCourseId();
      const [course, history] = await Promise.all([
        runtime.store.getCourse(courseId),
        runtime.store.getHistory(courseId),
      ]);
      await showDashboard(
        pi,
        ctx,
        course,
        runtime.dashboardBuilder(course, history, runtime.clock.now()),
      );
    },
  });
  pi.registerCommand("study-off", {
    description: "Turn off tutor mode",
    handler: async (_args, ctx) => {
      runtime.persist(idleActivity(runtime.getActivity().state.courseId), ctx);
    },
  });
}

function registerTools(
  pi: ExtensionAPI,
  app: TutorApplication,
  getActivity: () => SessionActivity,
  persist: (next: SessionActivity, ctx: ExtensionContext) => void,
): void {
  const questionTool = (
    name: "tutor_present_question" | "tutor_present_transfer",
    label: string,
  ) => {
    pi.registerTool({
      name,
      label,
      description: "Present one source-cited free-response tutor question.",
      parameters: Type.Object({ question: questionSchema }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _update, ctx) {
        const question = params.question as Question;
        const next = await app.recordQuestion(getActivity(), question);
        persist(next, ctx);
        return toolResult(
          `${question.prompt}\n\nSource: ${citations(question.sourceRefs)}`,
          `${label} presented.`,
        );
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", label), 0, 0);
      },
      renderResult: renderToolResult,
    });
  };

  questionTool("tutor_present_question", "Tutor question");
  questionTool("tutor_present_transfer", "Tutor transfer question");

  pi.registerTool({
    name: "tutor_present_exam",
    label: "Tutor exam",
    description: "Present the complete source-cited exam without feedback.",
    parameters: Type.Object({
      items: Type.Array(questionSchema, { minItems: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const current = getActivity();
      if (current.state.tag !== "exam-generating") {
        throw new Error("An exam is not currently being generated");
      }
      const exam: ExamSession = {
        id: `exam-${current.state.operationId}`,
        operationId: current.state.operationId,
        startedAt: current.state.startedAt,
        ...(current.state.deadlineAt === undefined
          ? {}
          : { deadlineAt: current.state.deadlineAt }),
        status: "active",
        items: params.items as Question[],
        drafts: {},
      };
      const next = await app.recordExam(current, exam);
      persist(next, ctx);
      const display = exam.items
        .map(
          (item, index) =>
            `${index + 1}. ${item.prompt}\nSource: ${citations(item.sourceRefs)}`,
        )
        .join("\n\n");
      return toolResult(display, "Exam presented without feedback.");
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor exam"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_present_hint",
    label: "Tutor hint",
    description:
      "Present exactly the locally requested hint level with a source citation.",
    parameters: Type.Object({
      level: Type.Integer({ minimum: 1, maximum: 6 }),
      hint: Type.String(),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordHint(
        getActivity(),
        params.level as Exclude<HintLevel, 0>,
      );
      persist(next, ctx);
      return toolResult(
        `Hint ${params.level}: ${params.hint}\n\nSource: ${citation(params.sourceRef)}`,
        `Hint level ${params.level} presented.`,
      );
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Tutor hint ${args.level}`), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_record_grade",
    label: "Tutor feedback",
    description:
      "Record a source-cited canonical grade for the committed answer.",
    parameters: Type.Object({
      correctness: StringEnum([
        "correct",
        "partial",
        "incorrect",
        "ungradable",
      ] as const),
      gradingRationale: Type.String(),
      misconception: Type.Optional(Type.String()),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordGrade(getActivity(), {
        correctness: params.correctness,
        gradingRationale: params.gradingRationale,
        ...(params.misconception === undefined
          ? {}
          : { misconception: params.misconception }),
      });
      persist(next, ctx);
      const display = [
        `Result: ${params.correctness}`,
        params.gradingRationale,
        params.misconception === undefined
          ? undefined
          : `Misconception: ${params.misconception}`,
        `Source: ${citation(params.sourceRef)}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n");
      return toolResult(display, "Grade recorded.");
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor feedback"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_present_solution",
    label: "Tutor solution",
    description: "Present a requested solution with a source citation.",
    parameters: Type.Object({
      solution: Type.String(),
      sourceRef: sourceReferenceSchema,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assertCurrentCitation(getActivity().state, params.sourceRef);
      const next = await app.recordSolution(getActivity());
      persist(next, ctx);
      return toolResult(
        `${params.solution}\n\nSource: ${citation(params.sourceRef)}\n\nNow explain the solution in your own words.`,
        "Solution presented; explanation required.",
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor solution"), 0, 0);
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "tutor_record_explanation",
    label: "Tutor explanation",
    description:
      "Record the learner's self-explanation before transfer practice.",
    parameters: Type.Object({ explanation: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const next = await app.recordExplanation(
        getActivity(),
        params.explanation,
      );
      persist(next, ctx);
      return toolResult(
        "Explanation recorded. Next, complete an unaided transfer question.",
        "Explanation recorded; transfer required.",
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "Tutor explanation"), 0, 0);
    },
    renderResult: renderToolResult,
  });
}

function renderToolResult(
  result: {
    details?: ToolDisplayDetails;
    content: Array<{ type: string; text?: string }>;
  },
  _options: unknown,
  theme: { fg(color: string, text: string): string },
): Text {
  const display =
    result.details?.display ??
    result.content.find(({ type }) => type === "text")?.text ??
    "";
  return new Text(theme.fg("toolOutput", display), 0, 0);
}

function toolResult(
  display: string,
  modelResult: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDisplayDetails;
} {
  return {
    content: [{ type: "text", text: modelResult }],
    details: { display },
  };
}

function assertCurrentCitation(
  state: ActivityState,
  sourceRef: SourceReference,
): void {
  const question = questionForState(state);
  if (
    question === undefined ||
    !question.sourceRefs.some(
      (configured) =>
        configured.materialId === sourceRef.materialId &&
        configured.path === sourceRef.path &&
        configured.locator === sourceRef.locator,
    )
  ) {
    throw new Error("Citation is not configured for the current question");
  }
}

function questionForState(state: ActivityState): Question | undefined {
  switch (state.tag) {
    case "awaiting-primary-answer":
    case "awaiting-grade":
    case "hint-requested":
    case "reveal-requested":
    case "awaiting-correction":
    case "awaiting-explanation":
      return state.question;
    default:
      return undefined;
  }
}

function citations(sourceRefs: readonly SourceReference[]): string {
  return sourceRefs.map(citation).join("; ");
}

function citation(sourceRef: SourceReference): string {
  return `${sourceRef.path} (${sourceRef.locator})`;
}

function learnerSubmission(answer: string, confidence: number): string {
  return [
    "<exam-tutor-learner-submission>",
    `confidence: ${confidence}`,
    "answer:",
    answer,
    "</exam-tutor-learner-submission>",
  ].join("\n");
}

function learnerExplanation(explanation: string): string {
  return [
    "<exam-tutor-learner-explanation>",
    explanation,
    "</exam-tutor-learner-explanation>",
  ].join("\n");
}

function idleActivity(courseId?: string): SessionActivity {
  return {
    schemaVersion: 1,
    state: { tag: "idle", ...(courseId === undefined ? {} : { courseId }) },
  };
}

function splitCommand(args: string): { action: string; value: string } {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    action: match?.[1] ?? "",
    value: match?.[2] ?? "",
  };
}

async function commandValue(
  ctx: ExtensionCommandContext,
  current: string,
  prompt: string,
): Promise<string | undefined> {
  if (current.trim() !== "") return current.trim();
  if (ctx.mode !== "tui") {
    notifyError(ctx, `${prompt} is required`);
    return undefined;
  }
  const value = await ctx.ui.input(prompt);
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
