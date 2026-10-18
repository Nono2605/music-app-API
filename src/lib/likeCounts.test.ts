import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countsFromRows, countsFromRpc } from "./likeCounts";

describe("countsFromRpc", () => {
  it("un morceau sans ligne compte pour zéro", () => {
    const counts = countsFromRpc(["a", "b"], [{ track_id: "a", likes: 3 }]);
    assert.equal(counts.get("a"), 3);
    assert.equal(counts.get("b"), 0);
  });

  it("accepte un nombre rendu en texte (bigint)", () => {
    assert.equal(countsFromRpc(["a"], [{ track_id: "a", likes: "12" }]).get("a"), 12);
  });

  it("ignore un morceau qu'on n'a pas demandé et une valeur illisible ou négative", () => {
    const counts = countsFromRpc(["a"], [
      { track_id: "x", likes: 9 },
      { track_id: "a", likes: "abc" },
    ]);
    assert.equal(counts.size, 1);
    assert.equal(counts.get("a"), 0);
    assert.equal(countsFromRpc(["a"], [{ track_id: "a", likes: -2 }]).get("a"), 0);
  });

  it("sans réponse : tout à zéro", () => {
    assert.equal(countsFromRpc(["a"], null).get("a"), 0);
    assert.equal(countsFromRpc([], undefined).size, 0);
  });
});

describe("countsFromRows", () => {
  it("compte une ligne par « j'aime »", () => {
    const counts = countsFromRows(["a", "b"], [{ item_id: "a" }, { item_id: "a" }, { item_id: "b" }]);
    assert.equal(counts.get("a"), 2);
    assert.equal(counts.get("b"), 1);
  });

  it("ignore un morceau non demandé, et sans ligne c'est zéro", () => {
    const counts = countsFromRows(["a"], [{ item_id: "z" }]);
    assert.equal(counts.get("a"), 0);
    assert.equal(counts.has("z"), false);
  });
});
