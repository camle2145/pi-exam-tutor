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
const ADD_DIRECTORY_ACTION = "Add this folder recursively";
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
    const labeledEntries = labelEntries(root, entries);
    const choices = [
      FILTER_ACTION,
      ADD_DIRECTORY_ACTION,
      ...(directory === "." ? [] : [PARENT_ACTION]),
      ...labeledEntries.map((entry) => entry.label),
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
    if (selected === ADD_DIRECTORY_ACTION) {
      const selection = await resolveMaterialSelection(
        root,
        directory,
        filter,
        configuredPaths,
      );
      if (selection.paths.length === 0) continue;
      if (
        await ctx.ui.confirm(
          "Add course materials",
          `Add ${selection.paths.length} material file(s) from ${directory}?`,
        )
      ) {
        return selection;
      }
      return undefined;
    }
    if (selected === PARENT_ACTION && directory !== ".") {
      directory = parentDirectory(directory);
      continue;
    }

    const entry = labeledEntries.find(
      (candidate) => candidate.label === selected,
    )?.entry;
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
    directory = requestedPath;
  }
}

export function allExtensions(): ExtensionFilter {
  return { selectedExtensions: new Set(), allExtensionsSelected: true };
}

function labelEntries(
  root: string,
  entries: readonly MaterialDirectoryEntry[],
): readonly { entry: MaterialDirectoryEntry; label: string }[] {
  const usedLabels = new Set([
    FILTER_ACTION,
    ADD_DIRECTORY_ACTION,
    PARENT_ACTION,
  ]);
  return entries.map((entry) => {
    const baseLabel = entryLabel(entry);
    let label = baseLabel;
    let suffix = 0;
    while (usedLabels.has(label)) {
      suffix += 1;
      const pathLabel = relative(root, entry.path);
      label = `${baseLabel} [${pathLabel}${suffix === 1 ? "" : ` #${suffix}`}]`;
    }
    usedLabels.add(label);
    return { entry, label };
  });
}

function entryLabel(entry: MaterialDirectoryEntry): string {
  const name = entry.kind === "directory" ? `${entry.name}/` : entry.name;
  const disambiguatedName =
    entry.kind === "file" &&
    (entry.name === FILTER_ACTION || entry.name === ADD_DIRECTORY_ACTION)
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
