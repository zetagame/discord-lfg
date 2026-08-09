import assert from "node:assert/strict";
import test from "node:test";
import { chainAutocompleteChoices, ResponseType } from "../src/discord";

test("autocomplete selections visibly leave a comma for the next game", () => {
  const body = chainAutocompleteChoices({
    type: ResponseType.Autocomplete,
    data: {
      choices: [
        { name: "Street Fighter 6", value: "Street Fighter 6" },
        { name: "Tekken 8", value: "Street Fighter 6, Tekken 8" },
      ],
    },
  }) as { data: { choices: Array<{ name: string; value: string }> } };

  assert.deepEqual(body.data.choices[0], {
    name: "Street Fighter 6, ",
    value: "Street Fighter 6, ",
  });
  assert.deepEqual(body.data.choices[1], {
    name: "Street Fighter 6, Tekken 8, ",
    value: "Street Fighter 6, Tekken 8, ",
  });
});

test("autocomplete chaining does not exceed Discord's 100 character limits", () => {
  const value = "x".repeat(99);
  const body = chainAutocompleteChoices({
    type: ResponseType.Autocomplete,
    data: { choices: [{ name: "long", value }] },
  }) as { data: { choices: Array<{ name: string; value: string }> } };

  assert.equal(body.data.choices[0].name, value);
  assert.equal(body.data.choices[0].value, value);
});

test("non-autocomplete responses are unchanged", () => {
  const body = { type: ResponseType.ChannelMessage, data: { content: "ok" } };
  assert.equal(chainAutocompleteChoices(body), body);
});
