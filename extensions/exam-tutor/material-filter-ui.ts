import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionFilter } from "./material-path.js";

const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center" as const,
    width: "100%" as const,
    maxHeight: "50%" as const,
    margin: { left: 1, right: 1, bottom: 1 },
  },
};

/** Opens a transient extension filter dialog when a TUI is available. */
export async function selectExtensions(
  ctx: ExtensionCommandContext,
  extensions: readonly string[],
  current: ExtensionFilter,
): Promise<ExtensionFilter | undefined> {
  if (extensions.length === 0) return current;
  if (ctx.mode !== "tui") return undefined;

  const extensionSet = canonicalExtensionSet(extensions);
  const initiallySelected = current.allExtensionsSelected
    ? extensionSet
    : new Set(
        [...current.selectedExtensions]
          .map(canonicalExtension)
          .filter((extension) => extensionSet.has(extension)),
      );
  const selected = await ctx.ui.custom<Set<string> | undefined>(
    (tui, theme, _keybindings, done) =>
      createExtensionFilterPanel([...extensionSet], done, initiallySelected, {
        tui,
        theme,
      }),
    OVERLAY_OPTIONS,
  );
  if (selected === undefined) return undefined;

  return {
    selectedExtensions: selected,
    allExtensionsSelected: selected.size === extensionSet.size,
  };
}

export interface ExtensionFilterPanelOptions {
  readonly tui?: Pick<TUI, "requestRender">;
  readonly theme?: Theme;
}

/** A keyboard-driven multiselect panel independent of the surrounding dialog. */
export function createExtensionFilterPanel(
  extensions: readonly string[],
  complete: (selected: Set<string> | undefined) => void,
  initiallySelected: ReadonlySet<string> = new Set(extensions),
  options: ExtensionFilterPanelOptions = {},
): ExtensionFilterPanel {
  return new ExtensionFilterPanel(
    [...canonicalExtensionSet(extensions)],
    complete,
    new Set([...initiallySelected].map(canonicalExtension)),
    options,
  );
}

export class ExtensionFilterPanel implements Component, Focusable {
  private readonly selected: Set<string>;
  private index = 0;
  private completed = false;
  private _focused = false;

  constructor(
    private readonly extensions: readonly string[],
    private readonly complete: (selected: Set<string> | undefined) => void,
    initiallySelected: ReadonlySet<string>,
    private readonly options: ExtensionFilterPanelOptions,
  ) {
    this.selected = new Set(
      extensions.filter((extension) => initiallySelected.has(extension)),
    );
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (keyMatches(data, "escape")) {
      this.finish(undefined);
      return;
    }
    if (keyMatches(data, "up")) {
      this.index = Math.max(0, this.index - 1);
      this.refresh();
      return;
    }
    if (keyMatches(data, "down")) {
      this.index = Math.min(this.extensions.length - 1, this.index + 1);
      this.refresh();
      return;
    }
    if (keyMatches(data, "space")) {
      this.toggleFocused();
      return;
    }
    if (keyMatches(data, "enter")) {
      this.finish(new Set(this.selected));
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === "a") {
      this.selected.clear();
      for (const extension of this.extensions) this.selected.add(extension);
      this.refresh();
      return;
    }
    if (printable === "n") {
      this.selected.clear();
      this.refresh();
    }
  }

  invalidate(): void {}

  render(
    width: number,
    theme: Theme | undefined = this.options.theme,
  ): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines = this.extensions.map((extension, index) => {
      const marker = this.selected.has(extension) ? "[x]" : "[ ]";
      const cursor = index === this.index ? ">" : " ";
      return truncateToWidth(`${cursor} ${marker} ${extension}`, innerWidth);
    });
    lines.push(
      truncateToWidth("↑/↓ move • Space toggle • a all • n none", innerWidth),
      truncateToWidth("Enter apply • Esc cancel", innerWidth),
    );
    return borderedPanel(theme, width, "Filter extensions", lines);
  }

  private toggleFocused(): void {
    const extension = this.extensions[this.index];
    if (extension === undefined) return;
    if (this.selected.has(extension)) {
      this.selected.delete(extension);
    } else {
      this.selected.add(extension);
    }
    this.refresh();
  }

  private finish(selected: Set<string> | undefined): void {
    this.completed = true;
    this.complete(selected);
    this.refresh();
  }

  private refresh(): void {
    this.options.tui?.requestRender();
  }
}

function canonicalExtension(extension: string): string {
  return extension.toLowerCase();
}

function canonicalExtensionSet(extensions: readonly string[]): Set<string> {
  return new Set(extensions.map(canonicalExtension));
}

function keyMatches(
  data: string,
  key: Parameters<typeof matchesKey>[1],
): boolean {
  return (
    data === key || matchesKey(data, key) || (key === "space" && data === " ")
  );
}

function borderedPanel(
  theme: Theme | undefined,
  width: number,
  title: string,
  lines: readonly string[],
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const border = (text: string): string => theme?.fg("border", text) ?? text;
  const titleText = truncateToWidth(` ${title} `, innerWidth);
  const titleWidth = visibleWidth(titleText);
  const left = "─".repeat(Math.floor((innerWidth - titleWidth) / 2));
  const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));

  return [
    border(`╭${left}`) +
      (theme?.fg("accent", titleText) ?? titleText) +
      border(`${right}╮`),
    ...lines.map(
      (line) =>
        border("│") + truncateToWidth(line, innerWidth, "", true) + border("│"),
    ),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ];
}
