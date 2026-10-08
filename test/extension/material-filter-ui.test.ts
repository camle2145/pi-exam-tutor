import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import {
  createExtensionFilterPanel,
  selectExtensions,
} from "../../extensions/exam-tutor/material-filter-ui.js";
import type { ExtensionFilter } from "../../extensions/exam-tutor/material-path.js";

test("toggles extensions and applies the selected subset", () => {
  const completed = vi.fn();
  const panel = createExtensionFilterPanel([".md", ".pdf"], completed);

  panel.handleInput(" ");
  panel.handleInput("enter");

  expect(completed).toHaveBeenCalledWith(new Set([".pdf"]));
});

test("supports select all, deselect all, and cancel", () => {
  const completed = vi.fn();
  const panel = createExtensionFilterPanel([".md", ".pdf"], completed);

  panel.handleInput("n");
  panel.handleInput("a");
  panel.handleInput("escape");

  expect(completed).toHaveBeenCalledWith(undefined);
});

test("renders a focused, bounded extension panel", () => {
  const panel = createExtensionFilterPanel(
    [".long-extension", ".pdf"],
    () => {},
  );
  const theme = {
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;

  const lines = panel.render(24, theme);

  expect(lines.join("\n")).toContain("[x]");
  expect(lines.join("\n")).toContain("Space");
  expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
});

test("uses a TUI custom dialog and preserves the current filter on cancellation", async () => {
  const current: ExtensionFilter = {
    allExtensionsSelected: false,
    selectedExtensions: new Set([".md"]),
  };
  const custom = vi.fn(
    async (factory) =>
      new Promise((resolve) => {
        const panel = factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {},
          resolve,
        );
        panel.handleInput("escape");
      }),
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom },
  } as unknown as ExtensionCommandContext;

  await expect(selectExtensions(ctx, [".md", ".pdf"], current)).resolves.toBe(
    undefined,
  );
  expect(custom).toHaveBeenCalledTimes(1);
});

test("does not open a blank dialog when no extensions are available", async () => {
  const current: ExtensionFilter = {
    allExtensionsSelected: true,
    selectedExtensions: new Set(),
  };
  const custom = vi.fn();
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom },
  } as unknown as ExtensionCommandContext;

  await expect(selectExtensions(ctx, [], current)).resolves.toBe(current);
  expect(custom).not.toHaveBeenCalled();
});
