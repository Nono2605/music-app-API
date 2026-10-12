import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DECLARABLE_PROVENANCES, isDeclarableProvenance, provenanceError } from "./provenance";

describe("isDeclarableProvenance", () => {
  it("accepte ai et hybrid", () => {
    assert.equal(isDeclarableProvenance("ai"), true);
    assert.equal(isDeclarableProvenance("hybrid"), true);
  });

  it("refuse human : la bêta est 100 % IA", () => {
    assert.equal(isDeclarableProvenance("human"), false);
  });

  it("refuse tout ce qui n'est pas une valeur connue, y compris la casse et les types", () => {
    for (const value of ["AI", "Hybrid", "", " ai", "ai ", "other", null, undefined, 1, true, {}, ["ai"]]) {
      assert.equal(isDeclarableProvenance(value), false, JSON.stringify(value));
    }
  });

  it("la liste ne contient pas human", () => {
    assert.deepEqual([...DECLARABLE_PROVENANCES], ["ai", "hybrid"]);
  });
});

describe("provenanceError", () => {
  it("explique que la musique humaine n'est pas acceptée", () => {
    const message = provenanceError("provenance", "human");
    assert.match(message, /human-made music is not accepted/);
    assert.match(message, /^provenance:/);
  });

  it("liste les valeurs permises pour une valeur inconnue, sans citer human", () => {
    const message = provenanceError("content_provenance", "other");
    assert.equal(message, "content_provenance must be one of ai, hybrid");
    assert.doesNotMatch(message, /human/);
  });
});
