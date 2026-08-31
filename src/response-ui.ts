import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export type ResponsePurpose = "graded" | "correction" | "explanation" | "exam";
export type ResponseResult =
  | { kind: "submitted"; answer: string; confidence?: number }
  | { kind: "deferred"; draft: { answer: string; confidence?: number } }
  | { kind: "cancelled" };

export interface ResponseRequest {
  purpose: ResponsePurpose;
  answer?: string;
  confidence?: number;
  requiresConfidence: boolean;
}

const ANSWER_ROWS = 6;
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center" as const,
    width: "70%" as const,
    maxHeight: "50%" as const,
    margin: 1,
  },
};

/** Collects a response without changing tutor state or persisting a draft. */
export async function collectResponse(
  ctx: ExtensionContext,
  request: ResponseRequest,
): Promise<ResponseResult> {
  if (!ctx.hasUI) return { kind: "cancelled" };

  if (ctx.mode === "rpc") {
    return collectRpcResponse(ctx, request);
  }
  if (ctx.mode !== "tui") return { kind: "cancelled" };

  const answerResult = await ctx.ui.custom<string | ResponseResult>(
    (tui, theme, _keybindings, done) =>
      new AnswerPanel(tui, theme, request.answer ?? "", (answer) =>
        done(answer),
      ),
    OVERLAY_OPTIONS,
  );
  if (typeof answerResult !== "string") {
    return answerResult ?? { kind: "cancelled" };
  }
  if (!shouldCollectConfidence(request)) {
    return { kind: "submitted", answer: answerResult };
  }

  const confidenceResult = await ctx.ui.custom<ResponseResult>(
    (tui, theme, _keybindings, done) =>
      createConfidencePanel({
        answer: answerResult,
        confidence: request.confidence,
        theme,
        tui,
        onDone: done,
      }),
    OVERLAY_OPTIONS,
  );
  return confidenceResult ?? { kind: "cancelled" };
}

async function collectRpcResponse(
  ctx: ExtensionContext,
  request: ResponseRequest,
): Promise<ResponseResult> {
  const answer = await ctx.ui.editor("Your answer", request.answer);
  if (answer === undefined) return { kind: "cancelled" };
  if (!shouldCollectConfidence(request)) return { kind: "submitted", answer };

  const enteredConfidence = await ctx.ui.input("Confidence (0–100)");
  if (enteredConfidence === undefined) {
    return { kind: "deferred", draft: draft(answer, request.confidence) };
  }

  const confidence = parseConfidence(enteredConfidence);
  if (confidence === undefined) return { kind: "deferred", draft: { answer } };
  return { kind: "submitted", answer, confidence };
}

class AnswerPanel implements Component, Focusable {
  private readonly editor: Editor;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    answer: string,
    private readonly continueWith: (result: string | ResponseResult) => void,
  ) {
    this.editor = new Editor(compactEditorTui(tui), editorTheme(theme), {
      paddingX: 1,
    });
    this.editor.setText(answer);
    this.editor.onSubmit = (submitted) => this.continueWith(submitted);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.continueWith({
        kind: "deferred",
        draft: { answer: this.editor.getExpandedText() },
      });
      return;
    }
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const editorLines = this.editor.render(width);
    const bottomBorder = editorLines.pop() ?? "";
    while (editorLines.length < ANSWER_ROWS + 1) {
      editorLines.push("");
    }
    return [
      ...editorLines,
      bottomBorder,
      truncateToWidth(
        "Enter continue • Shift+Enter newline • Esc defer",
        width,
      ),
    ];
  }
}

export interface ConfidencePanelOptions {
  answer?: string;
  confidence?: number;
  theme?: Theme;
  tui?: Pick<TUI, "requestRender">;
  onDone?: (result: ResponseResult) => void;
}

/**
 * A confidence step that deliberately requires a key action before submission.
 * The default answer makes the keyboard seam usable without a surrounding UI.
 */
export function createConfidencePanel(
  options: ConfidencePanelOptions,
): ConfidencePanel {
  return new ConfidencePanel(options);
}

export class ConfidencePanel implements Component {
  private confidence: number;
  private typedDigits: string | undefined;
  private interacted = false;
  private completed: ResponseResult | undefined;

  constructor(private readonly options: ConfidencePanelOptions) {
    this.confidence = 50;
  }

  value(): number {
    return this.confidence;
  }

  error(): string | undefined {
    return isValidConfidence(this.confidence)
      ? undefined
      : "Confidence must be between 0–100";
  }

  result(): ResponseResult | undefined {
    return this.completed;
  }

  handleInput(data: string): void {
    if (this.completed !== undefined) return;
    if (matchesKey(data, "escape")) {
      this.complete({
        kind: "deferred",
        draft: draft(
          this.options.answer ?? "x",
          this.typedDigits === undefined &&
            this.options.confidence === undefined
            ? undefined
            : this.confidence,
        ),
      });
      return;
    }
    if (matchesKey(data, "left")) {
      this.adjust(-5);
      return;
    }
    if (matchesKey(data, "right")) {
      this.adjust(5);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.backspace();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.interacted && isValidConfidence(this.confidence)) {
        this.complete({
          kind: "submitted",
          answer: this.options.answer ?? "x",
          confidence: this.confidence,
        });
      }
      return;
    }
    const typed = decodeKittyPrintable(data) ?? data;
    if (/^\d+$/.test(typed)) {
      this.typedDigits = isValidConfidence(this.confidence)
        ? `${this.typedDigits ?? ""}${typed}`
        : typed;
      this.confidence = Number(this.typedDigits);
      this.interacted = true;
      this.refresh();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const confirmation = this.interacted ? "" : " (adjust or type to confirm)";
    const error = this.error();
    return [
      truncateToWidth(
        this.options.theme?.fg(
          this.interacted ? "text" : "dim",
          `Confidence: ${this.confidence} / 100${confirmation}`,
        ) ?? `Confidence: ${this.confidence} / 100${confirmation}`,
        width,
      ),
      ...(error === undefined
        ? []
        : [
            truncateToWidth(
              this.options.theme?.fg("error", error) ?? error,
              width,
            ),
          ]),
      truncateToWidth(
        "←/→ adjust • type number • Enter continue • Esc defer",
        width,
      ),
    ];
  }

  private adjust(amount: number): void {
    this.typedDigits = undefined;
    this.confidence = Math.max(0, Math.min(100, this.confidence + amount));
    this.interacted = true;
    this.refresh();
  }

  private backspace(): void {
    if (this.typedDigits === undefined) return;
    this.typedDigits = this.typedDigits.slice(0, -1);
    this.confidence = this.typedDigits === "" ? 0 : Number(this.typedDigits);
    this.interacted = true;
    this.refresh();
  }

  private complete(result: ResponseResult): void {
    this.completed = result;
    this.refresh();
    this.options.onDone?.(result);
  }

  private refresh(): void {
    this.options.tui?.requestRender();
  }
}

function compactEditorTui(tui: TUI): TUI {
  return new Proxy(tui, {
    get(target, property, receiver) {
      if (property !== "terminal")
        return Reflect.get(target, property, receiver);
      return new Proxy(target.terminal, {
        get(terminal, terminalProperty, terminalReceiver) {
          if (terminalProperty === "rows") return 20;
          return Reflect.get(terminal, terminalProperty, terminalReceiver);
        },
      });
    },
  });
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("border", text),
    selectList: {} as EditorTheme["selectList"],
  };
}

/** Corrections are not gradeable, so they never collect confidence. */
function shouldCollectConfidence(request: ResponseRequest): boolean {
  return request.purpose !== "correction" && request.requiresConfidence;
}

function parseConfidence(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const confidence = Number(value);
  return isValidConfidence(confidence) ? confidence : undefined;
}

function isValidConfidence(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function draft(
  answer: string,
  confidence: number | undefined,
): { answer: string; confidence?: number } {
  return confidence === undefined ? { answer } : { answer, confidence };
}
