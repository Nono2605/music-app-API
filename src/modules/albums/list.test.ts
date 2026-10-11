import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { containsPattern, isUuid, parseListParams, toAlbumSummary } from "./list";

describe("isUuid", () => {
  it("accepte un UUID, refuse le reste", () => {
    assert.equal(isUuid("0b9f2c4e-6c1a-4f5d-9a77-3e2d8c1b5a40"), true);
    assert.equal(isUuid("0B9F2C4E-6C1A-4F5D-9A77-3E2D8C1B5A40"), true);
    for (const bad of ["", "mara", "0b9f2c4e", "0b9f2c4e-6c1a-4f5d-9a77-3e2d8c1b5a4", ["0b9f2c4e-6c1a-4f5d-9a77-3e2d8c1b5a40"], 42, undefined, null]) {
      assert.equal(isUuid(bad), false, JSON.stringify(bad));
    }
  });
});

describe("parseListParams", () => {
  it("sans paramètre : 20 résultats depuis le début, pas de recherche", () => {
    assert.deepEqual(parseListParams({}), { limit: 20, offset: 0, q: "" });
  });

  it("lit limit, offset et q", () => {
    assert.deepEqual(parseListParams({ limit: "12", offset: "24", q: "  blue  " }), {
      limit: 12,
      offset: 24,
      q: "blue",
    });
  });

  it("plafonne limit à 100", () => {
    assert.equal(parseListParams({ limit: "5000" }).limit, 100);
  });

  it("une valeur inutilisable retombe sur le défaut au lieu de planter", () => {
    for (const limit of ["abc", "", "0", "-3", "2.5", "NaN", ["1", "2"], undefined]) {
      assert.equal(parseListParams({ limit }).limit, 20, `limit=${JSON.stringify(limit)}`);
    }
    for (const offset of ["abc", "", "-1", "1.5", ["1"], undefined]) {
      assert.equal(parseListParams({ offset }).offset, 0, `offset=${JSON.stringify(offset)}`);
    }
  });

  it("q absent, tableau ou trop long", () => {
    assert.equal(parseListParams({ q: ["a", "b"] }).q, "");
    assert.equal(parseListParams({ q: "x".repeat(500) }).q.length, 100);
  });
});

describe("containsPattern", () => {
  it("entoure de % et échappe les caractères spéciaux de LIKE", () => {
    assert.equal(containsPattern("blue"), "%blue%");
    assert.equal(containsPattern("100%"), "%100\\%%");
    assert.equal(containsPattern("a_b"), "%a\\_b%");
    assert.equal(containsPattern("a\\b"), "%a\\\\b%");
  });
});

describe("toAlbumSummary", () => {
  const base = {
    id: "a1",
    title: "Night Drive",
    cover_url: "https://cdn.example/cover.jpg",
    release_date: "2026-09-12",
    type: "album",
  };

  it("compte les morceaux publiés et ne renvoie pas leur liste", () => {
    const out = toAlbumSummary({
      ...base,
      artists: { name: "Mara", slug: "mara" },
      tracks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
    });
    assert.equal(out.track_count, 3);
    assert.equal("tracks" in out, false);
    assert.deepEqual(out.artists, { name: "Mara", slug: "mara" });
  });

  it("accepte l'artiste en tableau ou absent", () => {
    assert.deepEqual(
      toAlbumSummary({ ...base, artists: [{ name: "Mara", slug: "mara" }], tracks: [] }).artists,
      { name: "Mara", slug: "mara" }
    );
    assert.equal(toAlbumSummary({ ...base, artists: null, tracks: null }).artists, null);
    assert.equal(toAlbumSummary({ ...base, artists: [], tracks: null }).track_count, 0);
  });
});
