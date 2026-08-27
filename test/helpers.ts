import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, IdGenerator } from "../src/clock.js";

export class FakeClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: Date): void {
    this.value = new Date(value);
  }
}

export class SequenceIds implements IdGenerator {
  private index = 0;

  next(prefix: string): string {
    this.index += 1;
    return `${prefix}-${this.index}`;
  }
}

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-exam-tutor-"));
}
