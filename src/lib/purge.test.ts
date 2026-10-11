import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunk, isPurgeDue, type PurgeCandidate } from "./purge";

const now = new Date("2026-11-15T12:00:00Z");
const base: PurgeCandidate = {
  anonymized_at: "2026-10-11T10:00:00Z",
  purge_after: "2026-11-10T10:00:00Z",
  purged_at: null,
  legal_hold: false,
};

describe("isPurgeDue", () => {
  it("délai de grâce écoulé, ni purgé ni gelé : à purger", () => {
    assert.equal(isPurgeDue(base, now), true);
  });
  it("délai de grâce pas encore écoulé : non", () => {
    assert.equal(isPurgeDue({ ...base, purge_after: "2026-11-16T00:00:00Z" }, now), false);
  });
  it("pile à l'échéance : oui", () => {
    assert.equal(isPurgeDue({ ...base, purge_after: now.toISOString() }, now), true);
  });
  it("gel légal : jamais, même échu", () => {
    assert.equal(isPurgeDue({ ...base, legal_hold: true }, now), false);
  });
  it("déjà purgé : non", () => {
    assert.equal(isPurgeDue({ ...base, purged_at: "2026-11-11T00:00:00Z" }, now), false);
  });
  it("pas anonymisé : non, quoi que dise purge_after", () => {
    assert.equal(isPurgeDue({ ...base, anonymized_at: null }, now), false);
  });
  it("dans le doute on ne supprime pas : date absente, illisible ou gel inconnu", () => {
    assert.equal(isPurgeDue({ ...base, purge_after: null }, now), false);
    assert.equal(isPurgeDue({ ...base, purge_after: "pas une date" }, now), false);
    assert.equal(isPurgeDue({ ...base, legal_hold: null }, now), true); // null = pas de gel posé
  });
});

describe("chunk", () => {
  it("découpe en lots, le dernier pouvant être plus court", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
  it("liste vide : aucun lot", () => {
    assert.deepEqual(chunk([], 100), []);
  });
  it("taille invalide : erreur plutôt que boucle infinie", () => {
    assert.throws(() => chunk([1], 0));
  });
});
