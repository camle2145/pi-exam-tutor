import type {
  AnsweredAttempt,
  Attempt,
  CalibrationBin,
  Course,
  Dashboard,
  HintLevel,
  LearningHistory,
  UnaidedEvidence,
} from "./domain.js";
import { isAnsweredAttempt } from "./domain.js";
import { scheduler } from "./scheduler.js";

const calibrationRanges = [
  { range: "0–24", min: 0, max: 24 },
  { range: "25–49", min: 25, max: 49 },
  { range: "50–74", min: 50, max: 74 },
  { range: "75–100", min: 75, max: 100 },
] as const;

export function buildDashboard(
  course: Course,
  history: LearningHistory,
  now: Date,
): Dashboard {
  if (history.courseId !== course.id) {
    throw new Error("Learning history does not belong to this course");
  }

  const gradeableAttempts = history.attempts.filter(isGradeable);
  const unaidedCorrectRetrievalCount = history.attempts.filter(
    (attempt) =>
      attempt.unaidedAtSubmission && attempt.correctness === "correct",
  ).length;

  return {
    courseId: course.id,
    dueUnassisted: dueConcepts(history, "unassisted", now),
    dueAssisted: dueConcepts(history, "assisted", now),
    unaidedCorrectRetrievalCount,
    unaidedEvidence: evidenceFor(unaidedCorrectRetrievalCount),
    ...(gradeableAttempts.length === 0
      ? {}
      : {
          confidenceMeanAbsoluteError: mean(
            gradeableAttempts.map((attempt) =>
              Math.abs(attempt.confidence - correctnessPercent(attempt)),
            ),
          ),
        }),
    confidenceCalibration: calibration(gradeableAttempts),
    maximumHintLevel: maximumHintLevel(history.attempts),
    hintReliance: {
      assistedAttempts: history.attempts.filter(
        (attempt) => attempt.highestHintLevel > 0 || attempt.revealed,
      ).length,
      totalAttempts: history.attempts.length,
    },
    misconceptions: Object.entries(history.concepts).flatMap(
      ([conceptId, progress]) =>
        progress.misconceptions
          .filter((misconception) => misconception.resolvedAt === undefined)
          .map(({ text }) => ({ conceptId, text })),
    ),
  };
}

function dueConcepts(
  history: LearningHistory,
  trackName: "unassisted" | "assisted",
  now: Date,
): string[] {
  return Object.entries(history.concepts)
    .filter(([, progress]) => {
      const dueAt = scheduler.dueAt(progress[trackName]);
      return dueAt !== undefined && dueAt <= now;
    })
    .map(([conceptId]) => conceptId);
}

type GradeableAttempt = AnsweredAttempt & { confidence: number };

function isGradeable(attempt: Attempt): attempt is GradeableAttempt {
  return (
    isAnsweredAttempt(attempt) &&
    attempt.confidence !== undefined &&
    attempt.correctness !== undefined &&
    attempt.correctness !== "ungradable"
  );
}

function correctnessPercent(attempt: GradeableAttempt): number {
  return attempt.correctness === "correct" ? 100 : 0;
}

function calibration(attempts: readonly GradeableAttempt[]): CalibrationBin[] {
  return calibrationRanges.map(({ range, min, max }) => {
    const inRange = attempts.filter(
      (attempt) => attempt.confidence >= min && attempt.confidence <= max,
    );
    if (inRange.length === 0) {
      return { range, attempts: 0 };
    }
    return {
      range,
      attempts: inRange.length,
      meanConfidence: mean(inRange.map(({ confidence }) => confidence)),
      fullyCorrectRate:
        inRange.filter(({ correctness }) => correctness === "correct").length /
        inRange.length,
    };
  });
}

function maximumHintLevel(attempts: readonly Attempt[]): HintLevel {
  return attempts.reduce<HintLevel>(
    (maximum, attempt) =>
      Math.max(maximum, attempt.highestHintLevel) as HintLevel,
    0,
  );
}

function evidenceFor(count: number): UnaidedEvidence {
  if (count === 0) {
    return "not demonstrated";
  }
  if (count < 3) {
    return "emerging";
  }
  return "established evidence";
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
