import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import extension, {
  type ExamTutorAdapterDependencies,
} from "../extensions/exam-tutor/index.js";
import type { TutorApplication } from "../src/application.js";
import type {
  Course,
  Dashboard,
  ExamSession,
  Question,
  SessionActivity,
} from "../src/domain.js";
import type { Store } from "../src/storage.js";

const now = new Date("2026-08-27T09:00:00.000Z");
const course: Course = {
  schemaVersion: 1,
  id: "course-1",
  name: "Physics",
  revision: 1,
  createdAt: now.toISOString(),
  appliedOperationIds: [],
  partialAnswerPolicy: "remediate",
  materials: [
    {
      id: "material-1",
      path: "/courses/physics/notes.md",
      addedAt: now.toISOString(),
    },
  ],
  concepts: [{ id: "kinematics", name: "Kinematics" }],
};
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
const exam: ExamSession = {
  id: "exam-1",
  operationId: "operation-1",
  startedAt: now.toISOString(),
  status: "active",
  items: [
    {
      id: "1",
      kind: "exam",
      targetConceptId: "kinematics",
      prompt: "Explain acceleration.",
      sourceRefs: [
        {
          materialId: "material-1",
          path: "/courses/physics/notes.md",
          locator: "# acceleration",
        },
      ],
    },
  ],
  drafts: {},
};
const idle: SessionActivity = {
  schemaVersion: 1,
  state: { tag: "idle", courseId: course.id },
};
const activeExam: SessionActivity = {
  schemaVersion: 1,
  state: { tag: "exam-active", courseId: course.id, exam },
};
const awaitingAnswer: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "awaiting-primary-answer",
    courseId: course.id,
    mode: "study",
    question,
    hintLevel: 0,
    revealed: false,
  },
};
const awaitingGrade: SessionActivity = {
  schemaVersion: 1,
  state: {
    tag: "awaiting-grade",
    courseId: course.id,
    mode: "study",
    attemptId: "attempt-1",
    purpose: "primary",
    question,
    hintLevel: 0,
  },
};

function createDependencies(
  overrides: Partial<TutorApplication> = {},
): ExamTutorAdapterDependencies & { app: TutorApplication } {
  const app = {
    createCourse: vi.fn(async () => course),
    selectCourse: vi.fn(async () => idle),
    addMaterial: vi.fn(async () => course),
    requestMode: vi.fn(async () => idle),
    recordQuestion: vi.fn(async () => idle),
    acceptSubmission: vi.fn(async () => idle),
    requestHint: vi.fn(async () => idle),
    recordHint: vi.fn(async () => idle),
    requestReveal: vi.fn(async () => idle),
    recordSolution: vi.fn(async () => idle),
    recordGrade: vi.fn(async () => idle),
    recordExplanation: vi.fn(async () => idle),
    recordExam: vi.fn(async () => activeExam),
    submitExam: vi.fn(async () => idle),
    serializeActivity: vi.fn((activity: SessionActivity) =>
      JSON.stringify(activity),
    ),
    restoreActivity: vi.fn((snapshot: string) => JSON.parse(snapshot)),
    ...overrides,
  } as TutorApplication;
  const dashboard: Dashboard = {
    courseId: course.id,
    dueUnassisted: [],
    dueAssisted: [],
    unaidedCorrectRetrievalCount: 0,
    unaidedEvidence: "not demonstrated",
    confidenceCalibration: [
      { range: "0–24", attempts: 0 },
      { range: "25–49", attempts: 0 },
      { range: "50–74", attempts: 0 },
      { range: "75–100", attempts: 0 },
    ],
    maximumHintLevel: 0,
    hintReliance: { assistedAttempts: 0, totalAttempts: 0 },
    misconceptions: [],
  };
  const store = {
    listCourses: vi.fn(async () => [course]),
    getCourse: vi.fn(async () => course),
    getHistory: vi.fn(async () => ({
      schemaVersion: 1 as const,
      courseId: course.id,
      revision: 0,
      appliedOperationIds: [],
      attempts: [],
      concepts: {},
    })),
  } as unknown as Store;
  return {
    app,
    store,
    clock: { now: () => new Date(now) },
    buildDashboard: vi.fn(() => dashboard),
  };
}

function createFakePi(
  options: {
    activity?: SessionActivity;
    activities?: SessionActivity[];
    mode?: ExtensionContext["mode"];
  } = {},
) {
  const commands = new Map<
    string,
    { handler: Function; description?: string }
  >();
  const tools = new Map<
    string,
    { execute: Function; renderResult?: Function; executionMode?: string }
  >();
  const handlers = new Map<string, Function[]>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sentMessages: unknown[] = [];
  const branch = (
    options.activities ??
    (options.activity === undefined ? [] : [options.activity])
  ).map((activity) => ({
    type: "custom",
    customType: "pi-exam-tutor/activity-v1",
    data: activity,
  }));
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(async () => undefined),
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
  const context = {
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") === "tui",
    cwd: process.cwd(),
    ui,
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  const api = {
    registerCommand(name: string, definition: { handler: Function }) {
      commands.set(name, definition);
    },
    registerTool(definition: { name: string; execute: Function }) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    sendMessage(message: unknown, sendOptions?: unknown) {
      sentMessages.push({ message, options: sendOptions });
    },
    registerMessageRenderer: vi.fn(),
  } as unknown as ExtensionAPI;

  return {
    api,
    appendedEntries,
    context,
    sentMessages,
    ui,
    commandNames: () => [...commands.keys()],
    toolNames: () => [...tools.keys()],
    async dispatchInput(text: string) {
      const [handler] = handlers.get("input") ?? [];
      return handler?.({ type: "input", text, source: "interactive" }, context);
    },
    async startSession() {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, context);
      }
    },
    async beforeAgentStart(systemPrompt = "base prompt") {
      const [handler] = handlers.get("before_agent_start") ?? [];
      return handler?.(
        {
          type: "before_agent_start",
          prompt: "prompt",
          systemPrompt,
          systemPromptOptions: {},
        },
        context,
      );
    },
    async invokeCommand(name: string, args = "") {
      return commands.get(name)?.handler(args, context);
    },
    async executeTool(name: string, params: unknown) {
      return tools
        .get(name)
        ?.execute("tool-1", params, undefined, undefined, context);
    },
    tool: (name: string) => tools.get(name),
  };
}

test("exports a Pi extension factory", () => {
  expect(extension).toBeTypeOf("function");
});

test("registers every required tutor command and canonical tool", () => {
  const fake = createFakePi();
  extension(fake.api, createDependencies());

  expect(fake.commandNames()).toEqual(
    expect.arrayContaining([
      "study",
      "drill",
      "exam",
      "review",
      "dashboard",
      "hint",
      "reveal",
      "course",
      "study-off",
    ]),
  );
  expect(fake.toolNames()).toEqual(
    expect.arrayContaining([
      "tutor_present_question",
      "tutor_present_exam",
      "tutor_present_hint",
      "tutor_record_grade",
      "tutor_present_solution",
      "tutor_record_explanation",
      "tutor_present_transfer",
    ]),
  );
});

test("handles a complete exam draft locally without sending it to the model", async () => {
  const fake = createFakePi({ activity: activeExam });
  extension(fake.api, createDependencies());
  await fake.startSession();

  const result = await fake.dispatchInput("1. [confidence: 80]\nanswer");

  expect(result).toEqual({ action: "handled" });
  expect(fake.sentMessages).toEqual([]);
  expect(fake.appendedEntries.at(-1)).toMatchObject({
    customType: "pi-exam-tutor/activity-v1",
    data: {
      state: {
        tag: "exam-active",
        exam: { drafts: { "1": { answer: "answer", confidence: 80 } } },
      },
    },
  });
});

test("submits an active exam locally when its deadline expires", async () => {
  vi.useFakeTimers();
  try {
    const timedExam: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-active",
        courseId: course.id,
        exam: {
          ...exam,
          deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
    };
    const submitted: SessionActivity = {
      schemaVersion: 1,
      state: {
        tag: "exam-submitted",
        courseId: course.id,
        exam: {
          ...exam,
          deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
          submittedAt: new Date(now.getTime() + 60_000).toISOString(),
          status: "expired",
        },
      },
    };
    const submitExam = vi.fn(async () => submitted);
    const fake = createFakePi({ activity: timedExam });
    extension(fake.api, createDependencies({ submitExam }));
    await fake.startSession();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(submitExam).toHaveBeenCalledTimes(1);
    expect(submitExam).toHaveBeenCalledWith(timedExam);
    expect(fake.appendedEntries.at(-1)).toEqual({
      customType: "pi-exam-tutor/activity-v1",
      data: submitted,
    });
    expect(fake.sentMessages).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("rejects malformed exam drafts locally without changing activity", async () => {
  const fake = createFakePi({ activity: activeExam });
  extension(fake.api, createDependencies());
  await fake.startSession();

  expect(await fake.dispatchInput("answer without confidence")).toEqual({
    action: "handled",
  });
  expect(fake.appendedEntries).toEqual([]);
  expect(fake.sentMessages).toEqual([]);
  expect(fake.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("configured question header"),
    "error",
  );
});

test("restores only the latest branch-local activity and injects its prompt", async () => {
  const dependencies = createDependencies();
  const fake = createFakePi({ activities: [idle, awaitingAnswer] });
  extension(fake.api, dependencies);

  await fake.startSession();
  const result = await fake.beforeAgentStart();

  expect(dependencies.app.restoreActivity).toHaveBeenCalledTimes(1);
  expect(dependencies.app.restoreActivity).toHaveBeenCalledWith(
    JSON.stringify(awaitingAnswer),
  );
  expect(result.systemPrompt).toContain("base prompt");
  expect(result.systemPrompt).toContain("untrusted reference content");
  expect(result.systemPrompt).toContain("current hint level is 0");
});

test("does not inject tutor policy while activity is idle", async () => {
  const fake = createFakePi({ activity: idle });
  extension(fake.api, createDependencies());
  await fake.startSession();

  expect(await fake.beforeAgentStart()).toBeUndefined();
});

test("stores a regular answer before transforming it for grading", async () => {
  const acceptSubmission = vi.fn(async () => awaitingGrade);
  const dependencies = createDependencies({ acceptSubmission });
  const fake = createFakePi({ activity: awaitingAnswer });
  extension(fake.api, dependencies);
  await fake.startSession();

  const result = await fake.dispatchInput(
    "[confidence: 70]\nVelocity changes over time.",
  );

  expect(acceptSubmission).toHaveBeenCalledTimes(1);
  expect(acceptSubmission).toHaveBeenCalledWith(awaitingAnswer, {
    confidence: 70,
    answer: "Velocity changes over time.",
  });
  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: awaitingGrade,
  });
  expect(result).toMatchObject({
    action: "transform",
    text: expect.stringContaining("<exam-tutor-learner-submission>"),
  });
});

test("canonical grade tool calls one application use case and persists activity", async () => {
  const recordGrade = vi.fn(async () => idle);
  const dependencies = createDependencies({ recordGrade });
  const fake = createFakePi({ activity: awaitingGrade });
  extension(fake.api, dependencies);
  await fake.startSession();

  const result = await fake.executeTool("tutor_record_grade", {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
    sourceRef: question.sourceRefs[0],
  });

  expect(recordGrade).toHaveBeenCalledTimes(1);
  expect(recordGrade).toHaveBeenCalledWith(awaitingGrade, {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
  });
  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: idle,
  });
  expect(result).toMatchObject({
    content: [{ type: "text", text: "Grade recorded." }],
    details: { display: expect.stringContaining("Source:") },
  });
});

test("canonical tools reject a citation not configured for the current question", async () => {
  const recordGrade = vi.fn(async () => idle);
  const fake = createFakePi({ activity: awaitingGrade });
  extension(fake.api, createDependencies({ recordGrade }));
  await fake.startSession();

  await expect(
    fake.executeTool("tutor_record_grade", {
      correctness: "correct",
      gradingRationale: "Correct.",
      sourceRef: { ...question.sourceRefs[0], locator: "# unrelated" },
    }),
  ).rejects.toThrow("Citation is not configured");
  expect(recordGrade).not.toHaveBeenCalled();
  expect(fake.appendedEntries).toEqual([]);
});

test("present-exam rejects an invalid state before calling the application", async () => {
  const recordExam = vi.fn(async () => activeExam);
  const fake = createFakePi({ activity: idle });
  extension(fake.api, createDependencies({ recordExam }));
  await fake.startSession();

  await expect(
    fake.executeTool("tutor_present_exam", { items: exam.items }),
  ).rejects.toThrow("not currently being generated");
  expect(recordExam).not.toHaveBeenCalled();
});

test("custom tool renderer exposes canonical learner-facing feedback", async () => {
  const fake = createFakePi({ activity: awaitingGrade });
  extension(
    fake.api,
    createDependencies({ recordGrade: vi.fn(async () => idle) }),
  );
  await fake.startSession();
  const result = await fake.executeTool("tutor_record_grade", {
    correctness: "correct",
    gradingRationale: "Acceleration changes velocity.",
    sourceRef: question.sourceRefs[0],
  });
  const component = fake
    .tool("tutor_record_grade")
    ?.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text },
      {},
    );

  expect(component.render(120).join("\n")).toContain(
    "Acceleration changes velocity.",
  );
  expect(component.render(120).join("\n")).toContain(
    "/courses/physics/notes.md",
  );
});

test("all state-mutating tutor tools execute sequentially", () => {
  const fake = createFakePi();
  extension(fake.api, createDependencies());

  for (const name of fake.toolNames()) {
    expect(fake.tool(name)?.executionMode).toBe("sequential");
  }
});

test("uses interactive input when course creation omits its name", async () => {
  const dependencies = createDependencies();
  const fake = createFakePi();
  fake.ui.input.mockResolvedValueOnce("New course");
  extension(fake.api, dependencies);

  await fake.invokeCommand("course", "create");

  expect(fake.ui.input).toHaveBeenCalledWith("Course name");
  expect(dependencies.app.createCourse).toHaveBeenCalledWith("New course");
  expect(dependencies.app.selectCourse).toHaveBeenCalledTimes(1);
});

test("uses the custom TUI dashboard only in TUI mode", async () => {
  const fake = createFakePi({ activity: idle, mode: "tui" });
  extension(fake.api, createDependencies());
  await fake.startSession();

  await fake.invokeCommand("dashboard");

  expect(fake.ui.custom).toHaveBeenCalledTimes(1);
  expect(fake.sentMessages).toEqual([]);
});

test("renders dashboard as a non-triggering custom message outside TUI", async () => {
  const fake = createFakePi({ activity: idle, mode: "print" });
  extension(fake.api, createDependencies());
  await fake.startSession();

  await fake.invokeCommand("dashboard");

  expect(fake.ui.custom).not.toHaveBeenCalled();
  expect(fake.sentMessages).toContainEqual({
    message: expect.objectContaining({
      customType: "pi-exam-tutor/dashboard-v1",
      display: true,
      content: expect.stringContaining("Exam Tutor Dashboard"),
    }),
    options: { triggerTurn: false, deliverAs: "nextTurn" },
  });
});

test("study-off persists idle state and clears tutor status and widget", async () => {
  const fake = createFakePi({ activity: awaitingAnswer });
  extension(fake.api, createDependencies());
  await fake.startSession();

  await fake.invokeCommand("study-off");

  expect(fake.appendedEntries.at(-1)).toEqual({
    customType: "pi-exam-tutor/activity-v1",
    data: idle,
  });
  expect(fake.ui.setStatus).toHaveBeenLastCalledWith("exam-tutor", undefined);
  expect(fake.ui.setWidget).toHaveBeenLastCalledWith("exam-tutor", undefined);
});
