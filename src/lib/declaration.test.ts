import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isUnchangedDeclaration } from "./declaration";

describe("isUnchangedDeclaration", () => {
  it("aucune déclaration avant : ce n'est pas un doublon", () => {
    assert.equal(isUnchangedDeclaration(null, { provenance: "ai", description: null }), false);
  });

  it("même provenance, même description : doublon", () => {
    assert.equal(
      isUnchangedDeclaration({ provenance: "ai", description: "Suno" }, { provenance: "ai", description: "Suno" }),
      true
    );
  });

  it("sans description des deux côtés : doublon", () => {
    assert.equal(isUnchangedDeclaration({ provenance: "ai", description: null }, { provenance: "ai", description: null }), true);
  });

  it("provenance différente : une vraie nouvelle déclaration", () => {
    assert.equal(isUnchangedDeclaration({ provenance: "ai", description: null }, { provenance: "hybrid", description: null }), false);
  });

  it("description modifiée, ajoutée ou retirée : une vraie nouvelle déclaration", () => {
    assert.equal(isUnchangedDeclaration({ provenance: "ai", description: "Suno" }, { provenance: "ai", description: "Udio" }), false);
    assert.equal(isUnchangedDeclaration({ provenance: "ai", description: null }, { provenance: "ai", description: "Suno" }), false);
    assert.equal(isUnchangedDeclaration({ provenance: "ai", description: "Suno" }, { provenance: "ai", description: null }), false);
  });
});
