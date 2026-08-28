import {
  createEmptyCard,
  fsrs,
  Rating,
  type CardInput,
  type Grade,
} from "ts-fsrs";
import type {
  Attempt,
  Correctness,
  FsrsTrack,
  FsrsTrackName,
} from "./domain.js";

export interface Scheduler {
  apply(
    track: FsrsTrack | undefined,
    correctness: Correctness,
    now: Date,
  ): FsrsTrack | undefined;
  dueAt(track: FsrsTrack | undefined): Date | undefined;
}

const engine = fsrs({ enable_fuzz: false });

export const scheduler: Scheduler = {
  apply(track, correctness, now) {
    const rating = ratingForCorrectness(correctness);
    if (rating === undefined) {
      return undefined;
    }

    const card =
      track?.card === undefined
        ? createEmptyCard(now)
        : (track.card as unknown as CardInput);
    const result = engine.next(card, now, rating.value);

    return {
      card: result.card as unknown as Record<string, unknown>,
      reviewHistory: [
        ...(track?.reviewHistory ?? []),
        {
          reviewedAt: now.toISOString(),
          rating: rating.name,
          log: result.log as unknown as Record<string, unknown>,
        },
      ],
    };
  },

  dueAt(track) {
    if (track === undefined) {
      return undefined;
    }

    const due = track.card.due;
    if (
      !(due instanceof Date) &&
      typeof due !== "string" &&
      typeof due !== "number"
    ) {
      return undefined;
    }

    const date = new Date(due);
    return Number.isNaN(date.getTime()) ? undefined : date;
  },
};

export function trackForAttempt(attempt: Attempt): FsrsTrackName | undefined {
  if (
    attempt.correctness === undefined ||
    attempt.correctness === "ungradable"
  ) {
    return undefined;
  }

  return attempt.highestHintLevel > 0 || attempt.revealed
    ? "assisted"
    : "unassisted";
}

function ratingForCorrectness(
  correctness: Correctness,
): { value: Grade; name: "Again" | "Hard" | "Good" } | undefined {
  switch (correctness) {
    case "correct":
      return { value: Rating.Good, name: "Good" };
    case "partial":
      return { value: Rating.Hard, name: "Hard" };
    case "incorrect":
      return { value: Rating.Again, name: "Again" };
    case "ungradable":
      return undefined;
  }
}
