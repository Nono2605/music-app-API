import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_META, buildCredits, buildGenres, buildTrackMeta, topGenres, type TrackMeta } from "./trackMeta";

const labels = new Map([
  ["pop", "Pop"],
  ["rock", "Rock"],
  ["electronic", "Electronic"],
]);

describe("buildGenres", () => {
  it("le principal d'abord, puis les autres, avec leur libellé", () => {
    assert.deepEqual(buildGenres("rock", ["pop", "electronic"], labels), [
      { code: "rock", label: "Rock" },
      { code: "pop", label: "Pop" },
      { code: "electronic", label: "Electronic" },
    ]);
  });

  it("sans doublon, et sans code inconnu de la liste", () => {
    assert.deepEqual(buildGenres("pop", ["pop", "ghost"], labels), [{ code: "pop", label: "Pop" }]);
  });

  it("tolère l'absence de genres ou des colonnes pas encore là", () => {
    assert.deepEqual(buildGenres(null, undefined, labels), []);
    assert.deepEqual(buildGenres(undefined, "pop", labels), []);
  });
});

describe("buildCredits", () => {
  it("garde l'ordre choisi, et lie la page d'un artiste dont le nom est accepté", () => {
    const credits = buildCredits([
      { role: "producer", display_name: "Sam", position: 2, artists: null },
      { role: "featured", display_name: "Nova Kid", position: 1, artist_id: "a1", artists: { slug: "nova-kid", name_status: "approved", anonymized_at: null } },
    ]);
    assert.deepEqual(credits, [
      { role: "featured", name: "Nova Kid", slug: "nova-kid" },
      { role: "producer", name: "Sam", slug: null },
    ]);
  });

  it("accepte l'artiste lié sous forme de tableau (embarquement PostgREST)", () => {
    const credits = buildCredits([
      { role: "featured", display_name: "Nova", position: 1, artist_id: "a1", artists: [{ slug: "nova", name_status: "approved", anonymized_at: null }] },
    ]);
    assert.equal(credits[0].slug, "nova");
  });

  it("un artiste dont le compte est supprimé disparaît des crédits : son nom ne s'affiche plus", () => {
    const credits = buildCredits([
      { role: "featured", display_name: "Old Name", position: 1, artist_id: "a1", artists: { slug: "x", name_status: "approved", anonymized_at: "2026-10-01" } },
      { role: "featured", display_name: "Still Here", position: 2, artists: null },
    ]);
    assert.deepEqual(credits, [{ role: "featured", name: "Still Here", slug: null }]);
  });

  it("un nom pas encore accepté est affiché, mais sans lien vers la page", () => {
    const credits = buildCredits([
      { role: "featured", display_name: "Pending One", position: 1, artist_id: "a1", artists: { slug: "pending-one", name_status: "pending", anonymized_at: null } },
    ]);
    assert.deepEqual(credits, [{ role: "featured", name: "Pending One", slug: null }]);
  });

  it("ignore une ligne sans nom", () => {
    assert.deepEqual(buildCredits([{ role: "featured", display_name: "", position: 1 }]), []);
  });
});

describe("buildTrackMeta", () => {
  it("assemble genres, styles et crédits", () => {
    const meta = buildTrackMeta({
      labels,
      genreCode: "pop",
      extraGenreCodes: [],
      tags: ["dark", 3, "late night"],
      credits: [{ role: "writer", display_name: "Sam", position: 1 }],
    });
    assert.deepEqual(meta, {
      genres: [{ code: "pop", label: "Pop" }],
      tags: ["dark", "late night"],
      credits: [{ role: "writer", name: "Sam", slug: null }],
    });
  });

  it("des colonnes absentes donnent des listes vides", () => {
    assert.deepEqual(buildTrackMeta({ labels, genreCode: null, extraGenreCodes: undefined, tags: undefined, credits: [] }), EMPTY_META);
  });
});

describe("topGenres", () => {
  const meta = (...codes: string[]): TrackMeta => ({
    genres: codes.map((code) => ({ code, label: code.toUpperCase() })),
    tags: [],
    credits: [],
  });

  it("les genres les plus fréquents d'abord, à égalité dans l'ordre d'apparition", () => {
    const top = topGenres([meta("pop", "rock"), meta("rock"), meta("jazz"), meta("rock", "pop")]);
    assert.deepEqual(top.map((genre) => genre.code), ["rock", "pop", "jazz"]);
  });

  it("borne le nombre de genres", () => {
    assert.equal(topGenres([meta("a1", "b2", "c3")], 2).length, 2);
  });

  it("aucun morceau, aucun genre", () => {
    assert.deepEqual(topGenres([]), []);
  });
});
