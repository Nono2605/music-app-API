import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_PROVENANCES,
  DECLARABLE_PROVENANCES,
  declarationProblem,
  isDeclarableProvenance,
  latestDeclarations,
  provenanceError,
  releaseDeclarationProblem,
} from "./provenance";

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

describe("declarationProblem (mise en attente)", () => {
  it("laisse partir en relecture un morceau déclaré ai", () => {
    assert.equal(declarationProblem({ provenance: "ai", status: "declared" }), null);
    assert.equal(declarationProblem({ provenance: "ai" }), null);
  });

  it("bloque un morceau déclaré hybrid ou human, avec un message qui explique la bêta", () => {
    for (const provenance of ["hybrid", "human"]) {
      assert.match(declarationProblem({ provenance, status: "declared" }) ?? "", /AI-generated music only/);
    }
  });

  it("bloque un morceau sans déclaration", () => {
    assert.match(declarationProblem(null) ?? "", /Declare how this track was made/);
    assert.match(declarationProblem(undefined) ?? "", /Declare how this track was made/);
  });

  it("une déclaration refusée par un administrateur bloque, même pour ai", () => {
    assert.match(declarationProblem({ provenance: "ai", status: "rejected" }) ?? "", /rejected/);
  });

  it("provenance inconnue : bloque (dans le doute, on n'envoie pas en relecture)", () => {
    assert.notEqual(declarationProblem({ provenance: "AI" }), null);
    assert.notEqual(declarationProblem({ provenance: "" }), null);
  });

  it("la liste acceptée est bien ai seulement", () => {
    assert.deepEqual([...ACCEPTED_PROVENANCES], ["ai"]);
  });
});

describe("latestDeclarations", () => {
  it("garde la première ligne de chaque morceau (lignes triées de la plus récente à la plus ancienne)", () => {
    const rows = [
      { track_id: "a", provenance: "ai", declared_at: "2026-10-12" },
      { track_id: "b", provenance: "hybrid", declared_at: "2026-10-11" },
      { track_id: "a", provenance: "hybrid", declared_at: "2026-10-10" },
    ];
    const latest = latestDeclarations(rows);
    assert.equal(latest.size, 2);
    assert.equal(latest.get("a")?.provenance, "ai");
    assert.equal(latest.get("b")?.provenance, "hybrid");
  });
});

describe("releaseDeclarationProblem", () => {
  const tracks = [
    { id: "1", title: "One" },
    { id: "2", title: "Two" },
    { id: "3", title: "Three" },
    { id: "4", title: "Four" },
    { id: "5", title: "Five" },
  ];
  const ai = { provenance: "ai", status: "declared" };

  it("rien à signaler quand tous les morceaux sont déclarés ai", () => {
    const latest = new Map(tracks.map((track) => [track.id, ai]));
    assert.equal(releaseDeclarationProblem(tracks, latest), null);
  });

  it("une release sans morceau n'a rien à signaler ici (un autre contrôle s'en charge)", () => {
    assert.equal(releaseDeclarationProblem([], new Map()), null);
  });

  it("nomme le morceau en cause", () => {
    const latest = new Map([["1", ai], ["2", { provenance: "hybrid", status: "declared" }]]);
    const message = releaseDeclarationProblem(tracks.slice(0, 2), latest);
    assert.match(message ?? "", /1 track cannot be reviewed yet: “Two”/);
  });

  it("un morceau sans déclaration compte, et la liste est abrégée au-delà de trois", () => {
    const message = releaseDeclarationProblem(tracks, new Map());
    assert.match(message ?? "", /5 tracks cannot be reviewed yet: “One”, “Two”, “Three” and 2 more/);
  });
});
