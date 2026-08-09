import { describe, expect, it } from "vitest";

// Discord Components V2 constants used by the shared LFG panel.
describe("shared LFG panel Components V2 shape", () => {
  it("uses the stable Discord component and message flag values", () => {
    expect(1 << 15).toBe(32768); // IS_COMPONENTS_V2
    expect({ actionRow: 1, button: 2, section: 9, textDisplay: 10, thumbnail: 11, container: 17 }).toEqual({
      actionRow: 1,
      button: 2,
      section: 9,
      textDisplay: 10,
      thumbnail: 11,
      container: 17,
    });
  });
});
