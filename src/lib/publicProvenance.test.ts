import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { albumProvenance, chunk, publicProvenance } from "./publicProvenance";

describe("publicProvenance", () => {
  it("ai et hybrid ont un badge", () => {
    assert.equal(publicProvenance({ provenance: "ai" }), "ai");
    assert.equal(publicProvenance({ provenance: "hybrid" }), "hybrid");
  });

  it("le statut de relecture (en attente, approuvée) ne change rien", () => {
    assert.equal(publicProvenance({ provenance: "ai", status: "pending_review" }), "ai");
    assert.equal(publicProvenance({ provenance: "hybrid", status: "approved" }), "hybrid");
  });

  it("une déclaration écartée par un administrateur ne s'affiche pas", () => {
    assert.equal(publicProvenance({ provenance: "ai", status: "rejected" }), null);
  });

  it("human, valeur inconnue ou absence de déclaration : pas de badge", () => {
    assert.equal(publicProvenance({ provenance: "human" }), null);
    assert.equal(publicProvenance({ provenance: "whatever" }), null);
    assert.equal(publicProvenance({ provenance: "" }), null);
    assert.equal(publicProvenance(null), null);
    assert.equal(publicProvenance(undefined), null);
  });
});

describe("albumProvenance", () => {
  it("tous les morceaux en ai : l'album est ai", () => {
    assert.equal(albumProvenance(["ai", "ai", "ai"]), "ai");
    assert.equal(albumProvenance(["ai"]), "ai");
  });

  it("un morceau hybride, ou un mélange : l'album est hybrid", () => {
    assert.equal(albumProvenance(["ai", "hybrid"]), "hybrid");
    assert.equal(albumProvenance(["hybrid", "hybrid"]), "hybrid");
    assert.equal(albumProvenance(["ai", null]), "hybrid");
    assert.equal(albumProvenance([null, "hybrid"]), "hybrid");
  });

  it("aucun morceau, ou aucun morceau avec une provenance : pas de badge", () => {
    assert.equal(albumProvenance([]), null);
    assert.equal(albumProvenance([null, null]), null);
  });
});

describe("chunk", () => {
  it("découpe en lots de taille donnée, le dernier plus court", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
  });

  it("liste vide : aucun lot ; taille invalide : erreur", () => {
    assert.deepEqual(chunk([], 3), []);
    assert.throws(() => chunk([1], 0), RangeError);
    assert.throws(() => chunk([1], 1.5), RangeError);
  });

  it("ne modifie pas la liste d'origine", () => {
    const original = [1, 2, 3];
    chunk(original, 2);
    assert.deepEqual(original, [1, 2, 3]);
  });
});
