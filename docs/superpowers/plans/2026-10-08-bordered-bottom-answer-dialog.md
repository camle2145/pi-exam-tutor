# Bordered Bottom Answer Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make TUI answer and confidence collection a full-width, bottom-anchored, clearly bordered dialog without changing response behavior.

**Architecture:** Keep `collectResponse()` and its result protocol intact. Replace its shared overlay configuration with a nearly full-width bottom overlay, and frame the existing `Editor` and `ConfidencePanel` render output through one small ANSI-safe border helper. RPC and no-UI flows remain unchanged.

**Tech Stack:** TypeScript (strict), `@earendil-works/pi-tui`, Vitest.

## Global Constraints

- Scope is limited to the answer and confidence TUI dialogs; do not modify `/course`, course onboarding, command registration, or application/domain behavior.
- Both TUI steps use the same bottom-anchored, full-usable-width overlay configuration: `anchor: "bottom-center"`, `width: "100%"`, `margin: { left: 1, right: 1, bottom: 1 }`, and `maxHeight: "50%"`.
- Both dialogs must render visible left and right borders, a top border, and a bottom border at every width.
- Preserve editor focus forwarding, answer prefill, Enter/Shift+Enter/Escape behavior, confidence validation, explicit confidence reconfirmation, and returned `ResponseResult` values.
- Preserve the existing RPC (`ui.editor` then `ui.input`) and no-UI behavior exactly.
- Do not add dependencies or change public response-controller interfaces.

---

### Task 1: Characterize the shared bordered bottom-dialog contract

**Files:**
- Modify: `test/extension/response-ui.test.ts:25-63`

**Interfaces:**
- Consumes: `collectResponse(ctx, request): Promise<ResponseResult>`.
- Produces: regression evidence for the options and rendered frame used by both TUI response steps.

- [x] **Step 1: Add the failing layout assertions to the existing deferred-answer test**

Replace the current `overlayOptions` and `renderedLines` assertions with these additional checks after `collectResponse()` resolves:

```ts
expect(result).toEqual({ kind: "deferred", draft: { answer: "draft" } });
expect(renderedLines).toHaveLength(11);
expect(renderedLines[0]).toContain("╭");
expect(renderedLines[0]).toContain("╮");
expect(renderedLines.at(-1)).toContain("╰");
expect(renderedLines.at(-1)).toContain("╯");
for (const line of renderedLines.slice(1, -1)) {
  expect(line).toMatch(/^│.*│$/);
}
expect(overlayOptions).toEqual({
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center",
    width: "100%",
    maxHeight: "50%",
    margin: { left: 1, right: 1, bottom: 1 },
  },
});
```

The test fixture's theme functions already return unstyled text, so the literal border assertions verify visible columns without stripping ANSI escape codes.

- [x] **Step 2: Add a failing confidence-frame test**

Add this test after the intentional-confidence test:

```ts
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
});
```

- [x] **Step 3: Run the focused test to demonstrate the current layout is red**

Run:

```bash
npm test -- test/extension/response-ui.test.ts
```

Expected: FAIL because the current answer overlay is `70%` wide with scalar `margin: 1`, and both current components omit side borders.

### Task 2: Frame both TUI panels and adopt the bottom full-width overlay

**Files:**
- Modify: `extensions/exam-tutor/response-ui.ts:1-265`
- Test: `test/extension/response-ui.test.ts`

**Interfaces:**
- Consumes: existing `ResponseRequest`, `ResponseResult`, `Theme`, `Editor`, and `TUI` contracts.
- Produces: unchanged `collectResponse()` results rendered through a shared `borderedPanel(theme, width, title, lines)` helper.

- [x] **Step 1: Add the shared bottom-overlay configuration**

Replace `OVERLAY_OPTIONS` with this exact configuration; keep both `ctx.ui.custom()` calls using it:

```ts
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center" as const,
    width: "100%" as const,
    maxHeight: "50%" as const,
    margin: { left: 1, right: 1, bottom: 1 },
  },
};
```

- [x] **Step 2: Add an ANSI-safe shared panel-frame helper**

Extend the Pi TUI import with `visibleWidth`, then add this helper near `editorTheme()`:

```ts
function borderedPanel(
  theme: Theme | undefined,
  width: number,
  title: string,
  lines: string[],
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const border = (text: string): string =>
    theme?.fg("border", text) ?? text;
  const titleText = truncateToWidth(` ${title} `, innerWidth);
  const titleWidth = visibleWidth(titleText);
  const left = "─".repeat(Math.floor((innerWidth - titleWidth) / 2));
  const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));

  return [
    border(`╭${left}`) + (theme?.fg("accent", titleText) ?? titleText) + border(`${right}╮`),
    ...lines.map(
      (line) =>
        border("│") +
        truncateToWidth(line, innerWidth, "", true) +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(line))) +
        border("│"),
    ),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ];
}
```

The helper must use `visibleWidth()` for ANSI-aware sizing, and `truncateToWidth(..., "", true)` so wrapped or theme-styled lines cannot overwrite either side border.

- [x] **Step 3: Render the answer editor inside the frame**

Change `AnswerPanel.render()` to render its editor at `Math.max(1, width - 2)`, keep the existing six-row padding and guidance text, and pass its content through the helper:

```ts
render(width: number): string[] {
  const innerWidth = Math.max(1, width - 2);
  const editorLines = this.editor.render(innerWidth);
  const bottomBorder = editorLines.pop() ?? "";
  while (editorLines.length < ANSWER_ROWS + 1) {
    editorLines.push("");
  }
  return borderedPanel(this.theme, width, "Your answer", [
    ...editorLines,
    bottomBorder,
    truncateToWidth(
      "Enter continue • Shift+Enter newline • Esc defer",
      innerWidth,
    ),
  ]);
}
```

Store `theme` as a `private readonly` constructor property so this method can use it. Leave `handleInput`, `focused`, `invalidate`, `compactEditorTui`, and the editor's callback untouched.

- [x] **Step 4: Render confidence through the same frame**

Replace the array returned by `ConfidencePanel.render()` with a `borderedPanel()` call titled `"Confidence"`. Preserve the current confidence line, optional error line, and keyboard-help line verbatim, but truncate each content line to `innerWidth` before framing. The final structure is:

```ts
return borderedPanel(this.options.theme, width, "Confidence", [
  truncateToWidth(confidenceLine, innerWidth),
  ...(error === undefined
    ? []
    : [truncateToWidth(errorLine, innerWidth)]),
  truncateToWidth(
    "←/→ adjust • type number • Enter continue • Esc defer",
    innerWidth,
  ),
]);
```

Keep `handleInput`, `complete`, `refresh`, and all confidence semantics unchanged.

- [x] **Step 5: Run focused tests and inspect formatting**

Run:

```bash
npm test -- test/extension/response-ui.test.ts
npx prettier --write extensions/exam-tutor/response-ui.ts test/extension/response-ui.test.ts
npm test -- test/extension/response-ui.test.ts
```

Expected: the first focused run passes after implementation; Prettier changes only formatting; the second run passes all response UI tests.

- [x] **Step 6: Run full verification**

Run:

```bash
npm run typecheck
npm test
npx prettier --check extensions/exam-tutor/response-ui.ts test/extension/response-ui.test.ts
git diff --check
git status --short
```

Expected: typecheck, all tests, scoped formatting check, and diff check pass. `git status --short` must show the intentionally untracked `.manual-test/` and the pre-existing architecture-refactor plan, plus this new plan and the intended response UI/test changes only.

- [x] **Step 7: Commit the focused UI fix**

```bash
git add extensions/exam-tutor/response-ui.ts test/extension/response-ui.test.ts docs/superpowers/plans/2026-10-08-bordered-bottom-answer-dialog.md
git commit -m "fix: frame tutor answer dialogs"
```

## Plan Self-Review

**Spec coverage:** Task 1 locks in a bottom-anchored full-usable-width overlay and full visible frame. Task 2 makes the exact visual changes for both answer and confidence while explicitly retaining all existing functional behavior. Course commands and onboarding are excluded.

**Placeholder scan:** Every code change names an exact file and implementation interface, and all test and verification commands are concrete.

**Type consistency:** `borderedPanel()` accepts `Theme | undefined`, matching `ConfidencePanelOptions.theme` while accepting the required `Theme` held by `AnswerPanel`. It returns `string[]`, the return type required by both TUI components' `render()` methods.
