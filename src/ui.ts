import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Course, Dashboard, SessionActivity } from "./domain.js";

export const DASHBOARD_MESSAGE_TYPE = "pi-exam-tutor/dashboard-v1";
const UI_KEY = "exam-tutor";

export function updateTutorStatus(
  ctx: ExtensionContext,
  activity: SessionActivity,
): void {
  if (!ctx.hasUI) return;
  const { state } = activity;
  if (state.tag === "idle") {
    ctx.ui.setStatus(UI_KEY, undefined);
    ctx.ui.setWidget(UI_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(UI_KEY, ctx.ui.theme.fg("accent", `tutor: ${state.tag}`));
  ctx.ui.setWidget(UI_KEY, [
    ctx.ui.theme.fg("dim", `Exam Tutor · ${state.courseId} · ${state.tag}`),
  ]);
}

export async function showDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  course: Course,
  dashboard: Dashboard,
): Promise<void> {
  const text = dashboardText(course, dashboard);
  if (ctx.mode !== "tui") {
    pi.sendMessage(
      {
        customType: DASHBOARD_MESSAGE_TYPE,
        content: text,
        display: true,
        details: { courseId: course.id },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }

  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) =>
      new DashboardComponent(text, theme, () => done()),
  );
}

export function dashboardText(course: Course, dashboard: Dashboard): string {
  const calibration = dashboard.confidenceCalibration
    .map((bin) => {
      if (bin.attempts === 0) return `${bin.range}: no attempts`;
      const confidence = bin.meanConfidence?.toFixed(1) ?? "n/a";
      const accuracy =
        bin.fullyCorrectRate === undefined
          ? "n/a"
          : `${(bin.fullyCorrectRate * 100).toFixed(1)}%`;
      return `${bin.range}: n=${bin.attempts}, confidence=${confidence}, fully correct=${accuracy}`;
    })
    .join("\n");
  const misconceptions =
    dashboard.misconceptions.length === 0
      ? "none"
      : dashboard.misconceptions
          .map(({ conceptId, text }) => `${conceptId}: ${text}`)
          .join("\n");
  const mae =
    dashboard.confidenceMeanAbsoluteError === undefined
      ? "not available"
      : dashboard.confidenceMeanAbsoluteError.toFixed(1);

  return [
    `Exam Tutor Dashboard — ${course.name} (${course.id})`,
    `Due: unassisted ${dashboard.dueUnassisted.length}, assisted ${dashboard.dueAssisted.length}`,
    `Unaided evidence: ${dashboard.unaidedEvidence} (${dashboard.unaidedCorrectRetrievalCount} fully correct retrievals)`,
    `Calibration MAE: ${mae}`,
    "Calibration bins:",
    calibration,
    `Assistance: ${dashboard.hintReliance.assistedAttempts}/${dashboard.hintReliance.totalAttempts} attempts; maximum hint level ${dashboard.maximumHintLevel}`,
    "Unresolved misconceptions:",
    misconceptions,
  ].join("\n");
}

class DashboardComponent extends Container {
  constructor(
    text: string,
    theme: Theme,
    private readonly close: () => void,
  ) {
    super();
    this.addChild(new Text(theme.fg("accent", theme.bold(text)), 1, 1));
    this.addChild(
      new Text(theme.fg("dim", "Press Escape or Ctrl+C to close"), 1, 0),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
    }
  }

  override render(width: number): string[] {
    return super.render(width).map((line) => truncateToWidth(line, width));
  }
}
