import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { SessionActivity } from "../../src/domain.js";

export interface FakePiOptions {
  activity?: SessionActivity;
  activities?: SessionActivity[];
  mode?: ExtensionContext["mode"];
}

export function createFakePi(options: FakePiOptions = {}) {
  const commands = new Map<
    string,
    { handler: Function; description?: string }
  >();
  const tools = new Map<
    string,
    {
      execute: Function;
      renderResult?: Function;
      executionMode?: string;
      parameters?: unknown;
    }
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
    setEditorText: vi.fn(),
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
    registerTool(definition: {
      name: string;
      execute: Function;
      parameters?: unknown;
    }) {
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
    async agentSettled() {
      for (const handler of handlers.get("agent_settled") ?? []) {
        await handler({ type: "agent_settled" }, context);
      }
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

export type FakePi = ReturnType<typeof createFakePi>;

export function messageText(sent: unknown): string[] {
  const message = (sent as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? [message.content] : [];
}

export function lastPersistedDraft(fake: FakePi, questionId: string): unknown {
  const entry = fake.appendedEntries.at(-1)?.data as
    SessionActivity | undefined;
  return entry?.state.tag === "exam-active"
    ? entry.state.exam.drafts[questionId]
    : undefined;
}

export function reviewText(fake: FakePi): string {
  const call = fake.ui.custom.mock.calls.at(-1);
  const component = call?.[0](
    {},
    {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    {},
    () => {},
  );
  return component?.render(120).join("\n") ?? "";
}
