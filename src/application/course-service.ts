import { isAbsolute, normalize } from "node:path";
import {
  assertCourseInvariant,
  type Course,
  type CourseConceptProposal,
  type SessionActivity,
} from "../domain.js";
import { ApplicationRuntime } from "./runtime.js";

export class CourseService {
  constructor(private readonly runtime: ApplicationRuntime) {}

  async createCourse(name: string): Promise<Course> {
    return this.runtime.store.createCourse(name, this.runtime.operationId());
  }

  async selectCourse(
    courseId: string,
    session: SessionActivity,
  ): Promise<SessionActivity> {
    this.runtime.codec.assert(session);
    await this.runtime.store.getCourse(courseId);
    return this.runtime.activity({ tag: "idle", courseId });
  }

  async addMaterial(courseId: string, absolutePath: string): Promise<Course> {
    return this.addMaterials(courseId, [absolutePath]);
  }

  async addMaterials(
    courseId: string,
    absolutePaths: readonly string[],
  ): Promise<Course> {
    assertMaterialPaths(absolutePaths);
    const course = await this.runtime.store.getCourse(courseId);
    assertNewMaterialPaths(course, absolutePaths);
    const addedAt = this.runtime.clock.now().toISOString();
    const next: Course = {
      ...course,
      revision: course.revision + 1,
      materials: [
        ...course.materials,
        ...absolutePaths.map((path) => ({
          id: this.runtime.ids.next("material"),
          path,
          addedAt,
        })),
      ],
    };
    assertCourseInvariant(next);
    return this.runtime.store.saveCourse(
      next,
      course.revision,
      this.runtime.operationId(),
    );
  }

  async proposeConcepts(
    courseId: string,
    proposals: readonly CourseConceptProposal[],
  ): Promise<Course> {
    if (proposals.length === 0) {
      throw new Error("Must propose at least one concept");
    }
    for (const proposal of proposals) {
      if (typeof proposal.id !== "string" || proposal.id.trim() === "") {
        throw new Error("Each proposal must have a nonempty ID");
      }
      if (typeof proposal.name !== "string" || proposal.name.trim() === "") {
        throw new Error("Each proposal must have a nonempty name");
      }
      if (
        !Array.isArray(proposal.sourceRefs) ||
        proposal.sourceRefs.length === 0
      ) {
        throw new Error(
          "Each proposal must cite at least one configured material",
        );
      }
    }

    const course = await this.runtime.store.getCourse(courseId);

    const allIds = new Set(course.concepts.map(({ id }) => id));
    for (const proposal of proposals) {
      if (allIds.has(proposal.id)) {
        throw new Error(`Duplicate concept id: ${proposal.id}`);
      }
      allIds.add(proposal.id);
    }

    for (const proposal of proposals) {
      if (proposal.parentId !== undefined && !allIds.has(proposal.parentId)) {
        throw new Error(`Unknown parent concept: ${proposal.parentId}`);
      }
    }

    for (const proposal of proposals) {
      for (const sourceRef of proposal.sourceRefs) {
        const material = course.materials.find(
          ({ id }) => id === sourceRef.materialId,
        );
        if (material === undefined) {
          throw new Error(`Unknown source material: ${sourceRef.materialId}`);
        }
        if (sourceRef.path !== material.path) {
          throw new Error(
            `Source path must match the configured material path: ${sourceRef.path}`,
          );
        }
      }
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: [...proposals],
    };
    assertCourseInvariant(next);
    return this.runtime.store.saveCourse(
      next,
      course.revision,
      this.runtime.operationId(),
    );
  }

  async approveConcepts(
    courseId: string,
    conceptIds: readonly string[],
  ): Promise<Course> {
    const course = await this.runtime.store.getCourse(courseId);

    if (conceptIds.length === 0) {
      conceptIds = course.proposedConcepts.map(({ id }) => id);
    }

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    for (const id of conceptIds) {
      if (!byId.has(id)) {
        throw new Error(`No pending proposal: ${id}`);
      }
    }

    const approved: Course["concepts"] = conceptIds.map((id) => {
      const proposal = byId.get(id)!;
      return {
        id: proposal.id,
        name: proposal.name,
        parentId: proposal.parentId,
      };
    });

    const removedIds = new Set(conceptIds);
    const next: Course = {
      ...course,
      revision: course.revision + 1,
      concepts: [...course.concepts, ...approved],
      proposedConcepts: course.proposedConcepts.filter(
        ({ id }) => !removedIds.has(id),
      ),
    };
    assertCourseInvariant(next);
    return this.runtime.store.saveCourse(
      next,
      course.revision,
      this.runtime.operationId(),
    );
  }

  async editProposedConcept(
    courseId: string,
    conceptId: string,
    update: { name?: string; parentId?: string | null },
  ): Promise<Course> {
    const course = await this.runtime.store.getCourse(courseId);

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    if (!byId.has(conceptId)) {
      throw new Error(`No pending proposal: ${conceptId}`);
    }

    const merged: CourseConceptProposal = {
      ...byId.get(conceptId)!,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.parentId === undefined
        ? {}
        : update.parentId === null
          ? { parentId: undefined }
          : { parentId: update.parentId }),
    };

    const allIds = new Set([
      ...course.concepts.map(({ id }) => id),
      ...course.proposedConcepts.map(({ id }) => id),
    ]);
    if (
      merged.parentId !== undefined &&
      merged.parentId !== merged.id &&
      !allIds.has(merged.parentId)
    ) {
      throw new Error(`Unknown parent concept: ${merged.parentId}`);
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: course.proposedConcepts.map((c) =>
        c.id === conceptId ? merged : c,
      ),
    };
    assertCourseInvariant(next);
    return this.runtime.store.saveCourse(
      next,
      course.revision,
      this.runtime.operationId(),
    );
  }

  async removeProposedConcept(
    courseId: string,
    conceptId: string,
  ): Promise<Course> {
    const course = await this.runtime.store.getCourse(courseId);

    const byId = new Map(course.proposedConcepts.map((c) => [c.id, c]));
    if (!byId.has(conceptId)) {
      throw new Error(`No pending proposal: ${conceptId}`);
    }

    for (const proposal of course.proposedConcepts) {
      if (proposal.parentId === conceptId) {
        throw new Error(
          `Cannot remove concept that is a parent of: ${proposal.id}`,
        );
      }
    }

    const next: Course = {
      ...course,
      revision: course.revision + 1,
      proposedConcepts: course.proposedConcepts.filter(
        ({ id }) => id !== conceptId,
      ),
    };
    assertCourseInvariant(next);
    return this.runtime.store.saveCourse(
      next,
      course.revision,
      this.runtime.operationId(),
    );
  }
}

function assertMaterialPaths(absolutePaths: readonly string[]): void {
  if (absolutePaths.length === 0) {
    throw new Error("Must add at least one material path");
  }

  for (const path of absolutePaths) {
    if (!isAbsolute(path) || normalize(path) !== path) {
      throw new Error("Material path must be absolute and normalized");
    }
  }
}

function assertNewMaterialPaths(
  course: Course,
  absolutePaths: readonly string[],
): void {
  const configuredPaths = new Set(course.materials.map(({ path }) => path));
  const requestedPaths = new Set<string>();

  for (const path of absolutePaths) {
    if (configuredPaths.has(path)) {
      throw new Error(`Material path is already configured: ${path}`);
    }
    if (requestedPaths.has(path)) {
      throw new Error(`Duplicate material path: ${path}`);
    }
    requestedPaths.add(path);
  }
}
