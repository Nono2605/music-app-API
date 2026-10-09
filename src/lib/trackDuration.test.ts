import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickTrackDuration } from "./trackDuration";

const file = (created_at: string, duration_seconds: number | null) => ({ created_at, duration_seconds });

describe("pickTrackDuration", () => {
  it("aucun fichier : la durée repasse à null", () => {
    assert.equal(pickTrackDuration([]), null);
  });

  it("un fichier mesuré : sa durée", () => {
    assert.equal(pickTrackDuration([file("2026-10-01T10:00:00Z", 222)]), 222);
  });

  it("plusieurs fichiers : la durée du plus ANCIEN (celui qui est streamé), quel que soit l'ordre reçu", () => {
    const older = file("2026-10-01T10:00:00Z", 222);
    const newer = file("2026-10-02T10:00:00Z", 190);
    assert.equal(pickTrackDuration([older, newer]), 222);
    assert.equal(pickTrackDuration([newer, older]), 222);
  });

  it("le plus ancien jamais mesuré : on ne change rien (undefined), même si un plus récent est mesuré", () => {
    const legacy = file("2026-09-01T10:00:00Z", null);
    const measured = file("2026-10-02T10:00:00Z", 190);
    assert.equal(pickTrackDuration([legacy, measured]), undefined);
    assert.equal(pickTrackDuration([legacy]), undefined);
  });

  it("un fichier récent non mesuré n'empêche pas d'utiliser le plus ancien, mesuré", () => {
    assert.equal(pickTrackDuration([file("2026-10-01T10:00:00Z", 222), file("2026-10-03T10:00:00Z", null)]), 222);
  });

  it("ne modifie pas le tableau reçu", () => {
    const files = [file("2026-10-02T10:00:00Z", 1), file("2026-10-01T10:00:00Z", 2)];
    pickTrackDuration(files);
    assert.equal(files[0].duration_seconds, 1);
  });
});
