import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import {
  collectResponse,
  createConfidencePanel,
  type ResponseRequest,
} from "../src/response-ui.js";

const gradedRequest: ResponseRequest = {
  purpose: "graded",
  requiresConfidence: true,
};

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
          renderedLines = component.render(60);
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
  expect(renderedLines).toHaveLength(9); // six answer rows, borders, and hint
  expect(overlayOptions).toEqual({
    overlay: true,
    overlayOptions: {
      anchor: "bottom-center",
      width: "70%",
      maxHeight: "50%",
      margin: 1,
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

test("does not ask corrections for confidence", async () => {
  const rpcUi = {
    editor: vi.fn().mockResolvedValue("correction"),
    input: vi.fn(),
  };
  const rpcContext = {
    mode: "rpc",
    hasUI: true,
    ui: rpcUi,
  } as unknown as ExtensionContext;

  await expect(
    collectResponse(rpcContext, {
      purpose: "correction",
      requiresConfidence: false,
    }),
  ).resolves.toEqual({ kind: "submitted", answer: "correction" });
  expect(rpcUi.input).not.toHaveBeenCalled();
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
