import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TutorApplication } from "../../src/application.js";
import type { Clock } from "../../src/clock.js";
import { createDefaultTutorDependencies } from "../../src/default-dependencies.js";
import type { Course, Dashboard, LearningHistory } from "../../src/domain.js";
import { registerCommands } from "./commands.js";
import { createExamController } from "./exam-controller.js";
import { registerLifecycle } from "./lifecycle.js";
import { registerMessageRenderers } from "./renderers.js";
import { createResponseController } from "./response-controller.js";
import { ACTIVITY_ENTRY_TYPE, createSessionCoordinator } from "./runtime.js";
import { aggregateExamSubmission, registerTools } from "./tools.js";

export { ACTIVITY_ENTRY_TYPE } from "./runtime.js";

export interface ExamTutorAdapterDependencies {
  app: TutorApplication;
  store: {
    listCourses(): Promise<Course[]>;
    getCourse(courseId: string): Promise<Course>;
    getHistory(courseId: string): Promise<LearningHistory>;
  };
  clock: Clock;
  buildDashboard?: (
    course: Course,
    history: LearningHistory,
    now: Date,
  ) => Dashboard;
}

export default function examTutorExtension(
  pi: ExtensionAPI,
  supplied?: ExamTutorAdapterDependencies,
): void {
  const dependencies = supplied ?? defaultDependencies();
  const coordinator = createSessionCoordinator(
    pi,
    { app: dependencies.app, clock: dependencies.clock },
    { aggregateExamSubmission },
  );
  const responses = createResponseController(pi, coordinator, dependencies.app);
  const exams = createExamController(
    pi,
    coordinator,
    dependencies.app,
    dependencies.clock,
    aggregateExamSubmission,
  );

  registerLifecycle(pi, coordinator, responses, exams, dependencies);
  registerCommands(pi, {
    app: dependencies.app,
    store: dependencies.store,
    clock: dependencies.clock,
    getActivity: coordinator.activity,
    persist: coordinator.persist,
    selectedCourseId: coordinator.selectedCourseId,
    triggerTurn: coordinator.triggerTurn,
    resumeAnswer: responses.resume,
    editExamAnswer: exams.edit,
    submitExamWithReview: exams.submitWithReview,
    dashboardBuilder: dependencies.buildDashboard,
  });
  registerMessageRenderers(pi);
  registerTools(pi, {
    app: dependencies.app,
    getActivity: coordinator.activity,
    persist: coordinator.persist,
    showExamItem: exams.showActiveItem,
  });
}

function defaultDependencies(): ExamTutorAdapterDependencies {
  return createDefaultTutorDependencies();
}
