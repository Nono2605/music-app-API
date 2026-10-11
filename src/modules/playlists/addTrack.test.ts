import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addTrackOutcome } from "./addTrack";

describe("addTrackOutcome", () => {
  it("pas d'erreur : le morceau a été ajouté", () => {
    assert.equal(addTrackOutcome(null), "added");
  });

  it("violation d'unicité (23505) : le morceau était déjà dans la playlist", () => {
    assert.equal(addTrackOutcome({ code: "23505" }), "duplicate");
  });

  it("toute autre erreur est relancée telle quelle", () => {
    const fkViolation = { code: "23503", message: "track does not exist" };
    assert.throws(() => addTrackOutcome(fkViolation), (thrown) => thrown === fkViolation);
    // Une vraie Error (sans code) : un objet d'erreur Supabase n'est pas toujours typé.
    const unknown = new Error("connection reset");
    assert.throws(() => addTrackOutcome(unknown as { code?: string }), (thrown) => thrown === unknown);
  });
});
