import assert from "node:assert/strict";
import test from "node:test";
import { chainAutocompleteChoices, ResponseType } from "../src/discord";

test("autocomplete selections leave a comma for the next game", () => {
  const body = chainAutocompleteChoices({
    type: ResponseType.Autocomplete,
    data: {
      choices: [
        { name: "Street Fighter 6", value: "Street Fighter 6" },
        { name: "Tekken 8", value: "Street Fighter 6, Tekken 8" },
      ],
    },
  }) as { data: { choices: Array<{ value: string }> } };

  assert.equal(body.data.choices[0].value, "Street Fighter 6, ");
  assert.equal(body.data.choices[1].value, "Street Fighter 6, Tekken 8, ");
});

test("autocomplete chaining does not exceed Discord's 100 character value limit", () => {
  const value = "x".repeat(99);
  const body = chainAutocompleteChoices({
    type: ResponseType.Autocomplete,
    data: { choices: [{ name: "long", value }] },
  }) as { data: { choices: Array<{ value: string }> } };

  assert.equal(body.data.choices[0].value, value);
});

test("non-autocomplete responses are unchanged", () => {
  const body = { type: ResponseType.ChannelMessage, data: { content: "ok" } };
  assert.equal(chainAutocompleteChoices(body), body);
});
