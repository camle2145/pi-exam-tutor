import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface MaterialSelection {
  readonly paths: readonly string[];
  readonly kind: "file" | "directory";
}

export interface ExtensionFilter {
  readonly selectedExtensions: ReadonlySet<string>;
  readonly allExtensionsSelected: boolean;
}

export interface MaterialDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly disabled?: "already-added" | "no-eligible-files";
}

type MaterialPath = {
  readonly path: string;
  readonly kind: "file" | "directory";
};

/** Resolves a root-relative file or directory to its new, eligible files. */
export async function resolveMaterialSelection(
  rootDirectory: string,
  requestedPath: string,
  filter: ExtensionFilter,
  configuredPaths: ReadonlySet<string>,
): Promise<MaterialSelection> {
  if (isAbsolute(requestedPath)) {
    throw new Error("Material path must be relative to the launch directory");
  }

  const root = await canonicalRoot(rootDirectory);
  const selected = await resolveRequestedPath(root, requestedPath);
  const configured = await canonicalConfiguredPaths(configuredPaths);
  const paths = await eligibleFiles(selected, filter, configured);

  return { kind: selected.kind, paths };
}

/** Returns the extensions used by regular, non-symlink files under the root. */
export async function discoverExtensions(
  rootDirectory: string,
): Promise<readonly string[]> {
  const root = await canonicalRoot(rootDirectory);
  const files = await walkFiles(root, root);
  return [
    ...new Set(
      files.map((path) => extname(path).toLowerCase()).filter(Boolean),
    ),
  ].sort(localeCompare);
}

/** Lists direct children of a root-relative directory with current availability. */
export async function listMaterialDirectory(
  rootDirectory: string,
  requestedPath: string,
  filter: ExtensionFilter,
  configuredPaths: ReadonlySet<string>,
): Promise<readonly MaterialDirectoryEntry[]> {
  if (isAbsolute(requestedPath)) {
    throw new Error("Material path must be relative to the launch directory");
  }

  const root = await canonicalRoot(rootDirectory);
  const directory = await resolveRequestedPath(root, requestedPath);
  if (directory.kind !== "directory") {
    throw new Error("Material directory path must name a directory");
  }

  const configured = await canonicalConfiguredPaths(configuredPaths);
  const entries = await readdir(directory.path, { withFileTypes: true });
  const listed: MaterialDirectoryEntry[] = [];
  for (const entry of entries.sort((left, right) =>
    localeCompare(left.name, right.name),
  )) {
    const child = await inspectPath(resolve(directory.path, entry.name), root);
    if (child === undefined) continue;

    const disabled = await disabledReason(child, filter, configured);
    listed.push({
      name: entry.name,
      path: child.path,
      kind: child.kind,
      ...(disabled === undefined ? {} : { disabled }),
    });
  }
  return listed;
}

async function canonicalRoot(rootDirectory: string): Promise<string> {
  const root = await realpath(rootDirectory);
  const details = await stat(root);
  if (!details.isDirectory()) {
    throw new Error("Material root must be a directory");
  }
  return root;
}

async function resolveRequestedPath(
  root: string,
  requestedPath: string,
): Promise<MaterialPath> {
  const candidate = resolve(root, requestedPath);
  const inspected = await inspectPath(candidate, root);
  if (inspected === undefined) {
    throw new Error("Material path must name a regular file or directory");
  }
  return inspected;
}

async function inspectPath(
  candidate: string,
  root: string,
): Promise<MaterialPath | undefined> {
  const linkDetails = await lstat(candidate);
  if (linkDetails.isSymbolicLink()) return undefined;

  const canonical = await realpath(candidate);
  assertUnderRoot(root, canonical);
  const details = await stat(canonical);
  if (details.isFile()) return { path: canonical, kind: "file" };
  if (details.isDirectory()) return { path: canonical, kind: "directory" };
  return undefined;
}

async function walkFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    localeCompare(left.name, right.name),
  )) {
    const child = await inspectPath(resolve(directory, entry.name), root);
    if (child === undefined) continue;
    if (child.kind === "file") {
      files.push(child.path);
    } else {
      files.push(...(await walkFiles(root, child.path)));
    }
  }
  return files;
}

async function eligibleFiles(
  selected: MaterialPath,
  filter: ExtensionFilter,
  configuredPaths: ReadonlySet<string>,
): Promise<string[]> {
  const files =
    selected.kind === "file"
      ? [selected.path]
      : await walkFiles(selected.path, selected.path);
  return [...new Set(files)]
    .filter((path) => isEligible(path, filter))
    .filter((path) => !configuredPaths.has(path))
    .sort(localeCompare);
}

async function disabledReason(
  entry: MaterialPath,
  filter: ExtensionFilter,
  configuredPaths: ReadonlySet<string>,
): Promise<MaterialDirectoryEntry["disabled"]> {
  if (entry.kind === "file" && configuredPaths.has(entry.path)) {
    return "already-added";
  }
  const eligible = await eligibleFiles(entry, filter, configuredPaths);
  return eligible.length === 0 ? "no-eligible-files" : undefined;
}

function isEligible(path: string, filter: ExtensionFilter): boolean {
  if (filter.allExtensionsSelected) return true;
  const selected = new Set(
    [...filter.selectedExtensions].map((extension) => extension.toLowerCase()),
  );
  return selected.has(extname(path).toLowerCase());
}

async function canonicalConfiguredPaths(
  configuredPaths: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const paths = await Promise.all(
    [...configuredPaths].map(async (path) => {
      try {
        return await realpath(path);
      } catch {
        return resolve(path);
      }
    }),
  );
  return new Set(paths);
}

function assertUnderRoot(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Material path must remain beneath the launch directory");
  }
}

function localeCompare(left: string, right: string): number {
  return left.localeCompare(right);
}
