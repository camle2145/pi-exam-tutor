import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  discoverExtensions,
  listMaterialDirectory,
  resolveMaterialSelection,
  type ExtensionFilter,
} from "../../extensions/exam-tutor/material-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function allExtensions(): ExtensionFilter {
  return { allExtensionsSelected: true, selectedExtensions: new Set() };
}

function markdownOnlyFilter(): ExtensionFilter {
  return { allExtensionsSelected: false, selectedExtensions: new Set([".md"]) };
}

async function materialFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exam-tutor-materials-"));
  roots.push(root);
  await mkdir(join(root, "materials", "nested"), { recursive: true });
  await mkdir(join(root, "all-added"));
  await mkdir(join(root, "pdf-only"));
  await writeFile(join(root, "materials", "lecture.md"), "lecture");
  await writeFile(join(root, "materials", "worksheet.pdf"), "worksheet");
  await writeFile(join(root, "materials", "nested", "solution.md"), "solution");
  await writeFile(join(root, "materials", "existing.md"), "existing");
  await writeFile(join(root, "all-added", "existing.md"), "existing");
  await writeFile(join(root, "pdf-only", "worksheet.pdf"), "worksheet");
  const outsideRoot = await mkdtemp(join(tmpdir(), "exam-tutor-outside-"));
  roots.push(outsideRoot);
  const outside = join(outsideRoot, "outside.md");
  await writeFile(outside, "outside");
  await symlink(outside, join(root, "materials", "outside.md"));
  return root;
}

test("resolves a filtered folder to new matching descendant files", async () => {
  const root = await materialFixtureRoot();
  const selected = await resolveMaterialSelection(
    root,
    "materials",
    markdownOnlyFilter(),
    new Set([join(root, "materials", "existing.md")]),
  );

  expect(selected).toEqual({
    kind: "directory",
    paths: [
      join(root, "materials", "lecture.md"),
      join(root, "materials", "nested", "solution.md"),
    ],
  });
});

test("rejects absolute paths and paths outside the canonical root", async () => {
  const root = await materialFixtureRoot();

  await expect(
    resolveMaterialSelection(root, "/tmp/file.md", allExtensions(), new Set()),
  ).rejects.toThrow();
  await expect(
    resolveMaterialSelection(root, "../outside.md", allExtensions(), new Set()),
  ).rejects.toThrow();
});

test("rejects traversal that would normalize back inside the root", async () => {
  const root = await materialFixtureRoot();

  await expect(
    resolveMaterialSelection(
      root,
      "materials/../materials",
      allExtensions(),
      new Set(),
    ),
  ).rejects.toThrow();
});

test("rejects paths that traverse an intermediate directory symlink", async () => {
  const root = await materialFixtureRoot();
  await symlink(join(root, "materials"), join(root, "alias"));

  await expect(
    resolveMaterialSelection(
      root,
      "alias/lecture.md",
      allExtensions(),
      new Set(),
    ),
  ).rejects.toThrow();
});

test("discovers extensions across the whole rooted tree", async () => {
  expect(await discoverExtensions(await materialFixtureRoot())).toEqual([
    ".md",
    ".pdf",
  ]);
});

test("includes extensionless files only when all extensions are selected", async () => {
  const root = await materialFixtureRoot();
  await writeFile(join(root, "materials", "notes"), "notes");

  await expect(
    resolveMaterialSelection(
      root,
      "materials/notes",
      allExtensions(),
      new Set(),
    ),
  ).resolves.toEqual({
    kind: "file",
    paths: [join(root, "materials", "notes")],
  });
  await expect(
    resolveMaterialSelection(
      root,
      "materials/notes",
      markdownOnlyFilter(),
      new Set(),
    ),
  ).resolves.toEqual({ kind: "file", paths: [] });
});

test("matches uppercase file extensions against lowercase filters", async () => {
  const root = await materialFixtureRoot();
  await writeFile(join(root, "materials", "UPPER.MD"), "upper");

  await expect(
    resolveMaterialSelection(
      root,
      "materials/UPPER.MD",
      markdownOnlyFilter(),
      new Set(),
    ),
  ).resolves.toEqual({
    kind: "file",
    paths: [join(root, "materials", "UPPER.MD")],
  });
});

test("ignores malformed configured paths", async () => {
  const root = await materialFixtureRoot();
  const existing = join(root, "materials", "existing.md");

  await expect(
    resolveMaterialSelection(
      root,
      "materials/existing.md",
      allExtensions(),
      new Set([
        "materials/existing.md",
        `${root}/materials/nested/../existing.md`,
      ]),
    ),
  ).resolves.toEqual({ kind: "file", paths: [existing] });
});

test("lists configured files and unavailable directories as disabled", async () => {
  const root = await materialFixtureRoot();
  const entries = await listMaterialDirectory(
    root,
    ".",
    markdownOnlyFilter(),
    new Set([
      join(root, "materials", "existing.md"),
      join(root, "all-added", "existing.md"),
    ]),
  );

  expect(entries).toEqual(
    expect.arrayContaining([
      {
        name: "all-added",
        path: join(root, "all-added"),
        kind: "directory",
        disabled: "no-eligible-files",
      },
      {
        name: "materials",
        path: join(root, "materials"),
        kind: "directory",
      },
      {
        name: "pdf-only",
        path: join(root, "pdf-only"),
        kind: "directory",
        disabled: "no-eligible-files",
      },
    ]),
  );

  const materialEntries = await listMaterialDirectory(
    root,
    "materials",
    markdownOnlyFilter(),
    new Set([join(root, "materials", "existing.md")]),
  );
  expect(materialEntries).toEqual(
    expect.arrayContaining([
      {
        name: "existing.md",
        path: join(root, "materials", "existing.md"),
        kind: "file",
        disabled: "already-added",
      },
      {
        name: "nested",
        path: join(root, "materials", "nested"),
        kind: "directory",
      },
    ]),
  );
});
