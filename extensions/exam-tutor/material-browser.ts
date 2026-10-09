import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectExtensions } from "./material-filter-ui.js";
import {
  discoverExtensions,
  listMaterialDirectory,
  resolveMaterialSelection,
  type ExtensionFilter,
  type MaterialDirectoryEntry,
  type MaterialSelection,
} from "./material-path.js";

const FILTER_ACTION = "Filter extensions…";
const PARENT_ACTION = "..";

/** Lets a learner select an eligible material file or directory beneath ctx.cwd. */
export async function selectMaterialPaths(
  ctx: ExtensionCommandContext,
  configuredPaths: ReadonlySet<string>,
): Promise<MaterialSelection | undefined> {
  const root = await realpath(ctx.cwd);
  let directory = ".";
  let filter = allExtensions();

  for (;;) {
    const entries = await listMaterialDirectory(
      root,
      directory,
      filter,
      configuredPaths,
    );
    const choices = [
      FILTER_ACTION,
      ...(directory === "." ? [] : [PARENT_ACTION]),
      ...entries.map(entryLabel),
    ];
    const selected = await ctx.ui.select(
      `Add course materials: ${directory}`,
      choices,
    );
    if (selected === undefined) return undefined;
    if (selected === FILTER_ACTION) {
      const next = await selectExtensions(
        ctx,
        await discoverExtensions(root),
        filter,
      );
      if (next !== undefined) filter = next;
      continue;
    }
    if (selected === PARENT_ACTION && directory !== ".") {
      directory = parentDirectory(directory);
      continue;
    }

    const entry = entries.find(
      (candidate) => entryLabel(candidate) === selected,
    );
    if (entry === undefined || entry.disabled !== undefined) continue;

    const requestedPath = relative(root, entry.path);
    if (entry.kind === "file") {
      return resolveMaterialSelection(
        root,
        requestedPath,
        filter,
        configuredPaths,
      );
    }

    const selection = await resolveMaterialSelection(
      root,
      requestedPath,
      filter,
      configuredPaths,
    );
    if (selection.paths.length === 0) continue;
    if (
      await ctx.ui.confirm(
        "Add course materials",
        `Add ${selection.paths.length} material file(s) from ${requestedPath}?`,
      )
    ) {
      return selection;
    }
    return undefined;
  }
}

export function allExtensions(): ExtensionFilter {
  return { selectedExtensions: new Set(), allExtensionsSelected: true };
}

function entryLabel(entry: MaterialDirectoryEntry): string {
  const name = entry.kind === "directory" ? `${entry.name}/` : entry.name;
  const disambiguatedName =
    entry.kind === "file" && entry.name === FILTER_ACTION
      ? `${name} (file)`
      : name;
  if (entry.disabled === "already-added") {
    return `${disambiguatedName} — already added`;
  }
  if (entry.disabled === "no-eligible-files") {
    return `${disambiguatedName} — no eligible files`;
  }
  return disambiguatedName;
}

function parentDirectory(directory: string): string {
  const segments = directory.split(/[\\/]/).filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "." : segments.join("/");
}
