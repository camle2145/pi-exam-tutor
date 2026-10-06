import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TutorMode } from "../../src/domain.js";

type LearnerResponseDetails = {
  answer: string;
  confidence?: number;
  mode: Exclude<TutorMode, "exam">;
};

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<LearnerResponseDetails>(
    "pi-exam-tutor/learner-response-v1",
    (message, options, theme) => {
      const details = message.details ?? { answer: "", mode: "study" };
      const confidence =
        details.confidence === undefined
          ? ""
          : ` · confidence ${details.confidence}`;
      const display = options.expanded
        ? [
            `Your answer: ${details.answer}`,
            ...(details.confidence === undefined
              ? []
              : [`Confidence: ${details.confidence}`]),
            `Mode: ${details.mode}`,
          ].join("\n")
        : `Your answer${confidence}`;
      return new Text(theme.fg("toolOutput", display), 0, 0);
    },
  );
  pi.registerMessageRenderer<{ prompt?: string; progress?: string }>(
    "pi-exam-tutor/exam-item-v1",
    (message, _options, theme) => {
      const details = message.details ?? {};
      const content =
        typeof message.content === "string" ? message.content : "Exam item";
      const display = [details.progress, details.prompt ?? content]
        .filter((line): line is string => line !== undefined)
        .join("\n");
      return new Text(theme.fg("toolOutput", display), 0, 0);
    },
  );
}
