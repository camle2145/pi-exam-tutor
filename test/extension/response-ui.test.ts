import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import {
  collectResponse,
  createConfidencePanel,
  type ResponseRequest,
} from "../../extensions/exam-tutor/response-ui.js";

const gradedRequest: ResponseRequest = {
  purpose: "graded",
  requiresConfidence: true,
};

function expectFrameWidths(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBe(width);
  }
}

test("requires an intentional confidence action before confirmation", () => {
  const panel = createConfidencePanel({ confidence: undefined });
  panel.handleInput("\r");
  expect(panel.result()).toBeUndefined();

  panel.handleInput("\x1b[C"); // right
  expect(panel.value()).toBe(55);
  panel.handleInput("\r");
  expect(panel.result()).toEqual({
    kind: "submitted",
    answer: "x",
    confidence: 55,
  });
});

test("renders confidence in the same bordered dialog frame", () => {
  const panel = createConfidencePanel({ confidence: 70 });

  const lines = panel.render(60);

  expect(lines[0]).toContain("╭");
  expect(lines[0]).toContain("╮");
  expect(lines.at(-1)).toContain("╰");
  expect(lines.at(-1)).toContain("╯");
  expect(lines.join("\n")).toContain("Confidence: 70 / 100");
  for (const line of lines.slice(1, -1)) {
    expect(line).toMatch(/^│.*│$/);
  }
  expectFrameWidths(lines, 60);

  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001B[31m${text}\u001B[0m`,
  } as unknown as Theme;
  const narrowAnsiLines = createConfidencePanel({
    confidence: 70,
    theme: ansiTheme,
  }).render(20);

  expect(narrowAnsiLines.join("\n")).toContain("\u001B[31m");
  expectFrameWidths(narrowAnsiLines, 20);
});

test("keeps a multiline answer bounded and defers on escape", async () => {
  let overlayOptions: unknown;
  let renderedLines: string[] = [];
  const tuiContext = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: vi.fn(async (factory, options) => {
        overlayOptions = options;
        return new Promise((resolve) => {
          const component = factory(
            {
              requestRender: vi.fn(),
              terminal: { rows: 40 },
            },
            {
              fg: (_color: string, text: string) => text,
              borderColor: (text: string) => text,
            },
            {},
            resolve,
          );
          renderedLines = component.render(20);
          component.handleInput("\x1b");
        });
      }),
    },
  } as unknown as ExtensionContext;

  const result = await collectResponse(tuiContext, {
    purpose: "graded",
    requiresConfidence: true,
    answer: "draft",
  });

  expect(result).toEqual({ kind: "deferred", draft: { answer: "draft" } });
  expect(renderedLines).toHaveLength(11);
  expect(renderedLines[0]).toContain("╭");
  expect(renderedLines[0]).toContain("╮");
  expect(renderedLines.at(-1)).toContain("╰");
  expect(renderedLines.at(-1)).toContain("╯");
  for (const line of renderedLines.slice(1, -1)) {
    expect(line).toMatch(/^│.*│$/);
  }
  expectFrameWidths(renderedLines, 20);
  expect(overlayOptions).toEqual({
    overlay: true,
    overlayOptions: {
      anchor: "bottom-center",
      width: "100%",
      maxHeight: "50%",
      margin: { left: 1, right: 1, bottom: 1 },
    },
  });
});

test("uses editor then numeric input in RPC mode", async () => {
  const rpcUi = {
    editor: vi.fn().mockResolvedValue("answer"),
    input: vi.fn().mockResolvedValue("75"),
  };
  const rpcContext = {
    mode: "rpc",
    hasUI: true,
    ui: rpcUi,
  } as unknown as ExtensionContext;

  await expect(collectResponse(rpcContext, gradedRequest)).resolves.toEqual({
    kind: "submitted",
    answer: "answer",
    confidence: 75,
  });
  expect(rpcUi.editor).toHaveBeenCalledWith("Your answer", undefined);
  expect(rpcUi.input).toHaveBeenCalledWith("Confidence (0–100)");
});

test("corrections never request confidence even when the request requires it", async () => {
  const rpcUi = {
    editor: vi.fn().mockResolvedValue("correction"),
    input: vi.fn(),
  };
  const rpcContext = {
    mode: "rpc",
    hasUI: true,
    ui: rpcUi,
  } as unknown as ExtensionContext;
  const tuiCustom = vi.fn(
    async (factory) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: vi.fn(), terminal: { rows: 40 } },
          {
            fg: (_color: string, text: string) => text,
            borderColor: (text: string) => text,
          },
          {},
          resolve,
        );
        component.handleInput("\r");
      }),
  );
  const tuiContext = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tuiCustom },
  } as unknown as ExtensionContext;
  const correctionRequest: ResponseRequest = {
    purpose: "correction",
    requiresConfidence: true,
    answer: "correction",
  };

  await expect(collectResponse(rpcContext, correctionRequest)).resolves.toEqual(
    {
      kind: "submitted",
      answer: "correction",
    },
  );
  await expect(collectResponse(tuiContext, correctionRequest)).resolves.toEqual(
    {
      kind: "submitted",
      answer: "correction",
    },
  );
  expect(rpcUi.input).not.toHaveBeenCalled();
  expect(tuiCustom).toHaveBeenCalledTimes(1);
});

test("prefills supplied TUI confidence but requires reconfirmation", async () => {
  const values: number[] = [];
  let initialRender = "";
  let customCalls = 0;
  const tuiContext = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: vi.fn(
        async (factory) =>
          new Promise((resolve) => {
            customCalls += 1;
            const component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              {
                fg: (_color: string, text: string) => text,
                borderColor: (text: string) => text,
              },
              {},
              resolve,
            );
            if (customCalls === 1) {
              component.handleInput("\r");
              return;
            }

            const panel = component as ReturnType<typeof createConfidencePanel>;
            initialRender = panel.render(80).join("\n");
            values.push(panel.value());
            panel.handleInput("\x1b[D");
            values.push(panel.value());
            panel.handleInput("\r");
          }),
      ),
    },
  } as unknown as ExtensionContext;

  await expect(
    collectResponse(tuiContext, {
      purpose: "graded",
      requiresConfidence: true,
      answer: "answer",
      confidence: 75,
    }),
  ).resolves.toEqual({ kind: "submitted", answer: "answer", confidence: 70 });
  expect(values).toEqual([75, 70]);
  expect(initialRender).toContain(
    "Confidence: 75 / 100 (adjust or type to confirm)",
  );
});

test("returns cancelled without UI", async () => {
  const context = {
    mode: "print",
    hasUI: false,
    ui: {},
  } as unknown as ExtensionContext;

  await expect(collectResponse(context, gradedRequest)).resolves.toEqual({
    kind: "cancelled",
  });
});

test("rejects invalid typed confidence until it is corrected", () => {
  const panel = createConfidencePanel({
    answer: "answer",
    confidence: undefined,
  });
  panel.handleInput("1");
  panel.handleInput("0");
  panel.handleInput("1");
  expect(panel.value()).toBe(101);
  expect(panel.error()).toBe("Confidence must be between 0–100");
  panel.handleInput("\r");
  expect(panel.result()).toBeUndefined();

  panel.handleInput("5");
  expect(panel.value()).toBe(5);
  panel.handleInput("\r");
  expect(panel.result()).toEqual({
    kind: "submitted",
    answer: "answer",
    confidence: 5,
  });
});
