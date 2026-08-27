import extension from "../extensions/exam-tutor/index.js";
import { expect, test } from "vitest";

test("exports a Pi extension factory", () => {
  expect(extension).toBeTypeOf("function");
});
