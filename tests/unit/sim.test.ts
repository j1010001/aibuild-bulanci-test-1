import { describe, expect, it } from "vitest";
import { createPracticeState, step } from "../../src/sim/state";

describe("sim skeleton", () => {
  it("createPracticeState returns a fresh practice state", () => {
    const s = createPracticeState();
    expect(s.phase).toBe("practice");
    expect(s.tick).toBe(0);
    expect(s.players).toEqual([]);
    expect(s.bullets).toEqual([]);
  });

  it("step advances tick and does not mutate its input", () => {
    const s0 = createPracticeState();
    const { state: s1 } = step(s0, [], 1 / 60);
    expect(s0.tick).toBe(0);
    expect(s1.tick).toBe(1);
    expect(s1).not.toBe(s0);
  });

  it("step is deterministic under identical inputs", () => {
    const a = step(createPracticeState(), [], 1 / 60).state;
    const b = step(createPracticeState(), [], 1 / 60).state;
    expect(a).toEqual(b);
  });
});
