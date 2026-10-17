import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canRenameArtist, isNameStatus, nameReviewProblem, statusForNewName, withNameReview } from "./artistNameReview";

describe("statusForNewName", () => {
  it("un nom sans ressemblance est accepté tout de suite", () => {
    assert.equal(statusForNewName(0), "approved");
  });

  it("un nom proche d'un autre attend l'administration", () => {
    assert.equal(statusForNewName(1), "pending");
    assert.equal(statusForNewName(4), "pending");
  });
});

describe("canRenameArtist", () => {
  it("un nom accepté est permanent", () => {
    assert.equal(canRenameArtist("approved"), false);
  });

  it("un nom en attente ou refusé se change", () => {
    assert.equal(canRenameArtist("pending"), true);
    assert.equal(canRenameArtist("rejected"), true);
  });
});

describe("withNameReview", () => {
  it("avant la migration : accepté, sans motif", () => {
    assert.deepEqual(withNameReview({ id: "a1", name: "Rafale" }), {
      id: "a1",
      name: "Rafale",
      name_status: "approved",
      name_review_note: null,
    });
  });

  it("garde un statut et un motif valides", () => {
    const row = withNameReview({ name_status: "rejected", name_review_note: "Imitation of a known artist" });
    assert.equal(row.name_status, "rejected");
    assert.equal(row.name_review_note, "Imitation of a known artist");
  });

  it("une valeur inconnue ne bloque personne", () => {
    assert.equal(withNameReview({ name_status: "weird" }).name_status, "approved");
    assert.equal(withNameReview({ name_review_note: 12 }).name_review_note, null);
  });
});

describe("isNameStatus", () => {
  it("n'accepte que les trois statuts", () => {
    assert.equal(isNameStatus("approved"), true);
    assert.equal(isNameStatus("pending"), true);
    assert.equal(isNameStatus("rejected"), true);
    assert.equal(isNameStatus("declined"), false);
    assert.equal(isNameStatus(null), false);
  });
});

describe("nameReviewProblem", () => {
  it("un nom accepté ne bloque rien", () => {
    assert.equal(nameReviewProblem("approved"), null);
    assert.equal(nameReviewProblem(undefined), null);
    assert.equal(nameReviewProblem(null, "ignored"), null);
  });

  it("un nom en attente : on peut préparer, pas soumettre", () => {
    assert.match(nameReviewProblem("pending") ?? "", /being reviewed/);
    assert.match(nameReviewProblem("pending") ?? "", /once it is approved/);
  });

  it("un nom refusé : le motif est lisible, et on dit quoi faire", () => {
    const message = nameReviewProblem("rejected", "Too close to a known artist.") ?? "";
    assert.match(message, /declined: Too close to a known artist\. Choose another name on your Profile page/);
    assert.doesNotMatch(message, /\.\./);
  });

  it("un nom refusé sans motif reste compréhensible", () => {
    const message = nameReviewProblem("rejected", "  ") ?? "";
    assert.match(message, /^Your artist name was declined\. Choose another name/);
  });
});
