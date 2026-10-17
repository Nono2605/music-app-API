import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  joinGenres,
  normalizeTag,
  parseCredits,
  parseGenres,
  parseReleaseDate,
  parseReleaseDetails,
  parseTags,
  splitGenres,
} from "./releaseMeta";

const ARTIST = "3f2b8c1e-5d4a-4b7e-9c3d-0a1b2c3d4e5f";

describe("parseGenres", () => {
  it("garde l'ordre : le premier est le principal", () => {
    assert.deepEqual(parseGenres(["rock", "pop"]), { ok: true, value: ["rock", "pop"] });
  });

  it("aucun genre est permis", () => {
    assert.deepEqual(parseGenres(undefined), { ok: true, value: [] });
    assert.deepEqual(parseGenres([]), { ok: true, value: [] });
  });

  it("retire les doublons", () => {
    assert.deepEqual(parseGenres(["pop", "rock", "pop"]), { ok: true, value: ["pop", "rock"] });
  });

  it("refuse plus de trois genres", () => {
    const result = parseGenres(["pop", "rock", "jazz", "blues"]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /up to 3/);
  });

  it("refuse ce qui n'est pas un code de genre", () => {
    for (const bad of [["Pop"], ["pop music"], [12], ["../x"], "pop", {}]) {
      assert.equal(parseGenres(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("splitGenres et joinGenres", () => {
  it("sépare le principal des autres, et les rassemble dans l'ordre", () => {
    assert.deepEqual(splitGenres(["rock", "pop", "jazz"]), { main: "rock", extras: ["pop", "jazz"] });
    assert.deepEqual(splitGenres([]), { main: null, extras: [] });
    assert.deepEqual(joinGenres("rock", ["pop", "jazz"]), ["rock", "pop", "jazz"]);
  });

  it("tolère des colonnes absentes ou vides", () => {
    assert.deepEqual(joinGenres(null, null), []);
    assert.deepEqual(joinGenres("pop", undefined), ["pop"]);
    assert.deepEqual(joinGenres("pop", ["pop", "rock"]), ["pop", "rock"]);
  });
});

describe("normalizeTag et parseTags", () => {
  it("met en forme : minuscules, espaces simples, sans dièse", () => {
    assert.equal(normalizeTag("  #Late   Night "), "late night");
  });

  it("accepte des styles libres, sans doublon", () => {
    assert.deepEqual(parseTags(["Dark", "dark", "late night", "lo-fi", "été"]), {
      ok: true,
      value: ["dark", "late night", "lo-fi", "été"],
    });
  });

  it("ignore un style vide et accepte l'absence de styles", () => {
    assert.deepEqual(parseTags(["  ", "#"]), { ok: true, value: [] });
    assert.deepEqual(parseTags(undefined), { ok: true, value: [] });
  });

  it("refuse trop de styles, trop courts, trop longs ou avec des symboles", () => {
    assert.equal(parseTags(["a1", "b2", "c3", "d4", "e5", "f6"]).ok, false);
    assert.equal(parseTags(["x"]).ok, false);
    assert.equal(parseTags(["a".repeat(25)]).ok, false);
    assert.equal(parseTags(["<script>"]).ok, false);
    assert.equal(parseTags(["http://spam.example"]).ok, false);
    assert.equal(parseTags("dark").ok, false);
    assert.equal(parseTags([3]).ok, false);
  });
});

describe("parseCredits", () => {
  it("accepte un artiste Vynl, et une personne sans page", () => {
    assert.deepEqual(
      parseCredits([
        { role: "featured", artist_id: ARTIST.toUpperCase(), name: "  Nova   Kid " },
        { role: "producer", name: "Someone Else" },
      ]),
      {
        ok: true,
        value: [
          { role: "featured", artist_id: ARTIST, name: "Nova Kid" },
          { role: "producer", artist_id: null, name: "Someone Else" },
        ],
      }
    );
  });

  it("« featured » par défaut", () => {
    const result = parseCredits([{ name: "Guest" }]);
    assert.deepEqual(result, { ok: true, value: [{ role: "featured", artist_id: null, name: "Guest" }] });
  });

  it("ne compte qu'une fois le même crédit", () => {
    const result = parseCredits([
      { name: "Guest" },
      { name: "guest" },
      { role: "writer", name: "Guest" },
      { artist_id: ARTIST, name: "A" },
      { artist_id: ARTIST, name: "B" },
    ]);
    // « Guest » invité, « Guest » auteur, puis l'artiste lié une seule fois (A ; B est le même artiste).
    assert.deepEqual(
      result.ok && result.value.map((credit) => `${credit.role}:${credit.name}`),
      ["featured:Guest", "writer:Guest", "featured:A"]
    );
  });

  it("refuse un rôle inconnu, un nom vide ou dangereux, un identifiant mal formé", () => {
    assert.equal(parseCredits([{ role: "dj", name: "X" }]).ok, false);
    assert.equal(parseCredits([{ name: "" }]).ok, false);
    assert.equal(parseCredits([{ name: "a".repeat(61) }]).ok, false);
    assert.equal(parseCredits([{ name: "<b>x</b>" }]).ok, false);
    assert.equal(parseCredits([{ name: "me@example.com" }]).ok, false);
    assert.equal(parseCredits([{ name: "ok", artist_id: "not-a-uuid" }]).ok, false);
    assert.equal(parseCredits(["Guest"]).ok, false);
    assert.equal(parseCredits("Guest").ok, false);
  });

  it("refuse trop de crédits", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `Guest ${i}` }));
    assert.equal(parseCredits(many).ok, false);
  });
});

describe("parseReleaseDate", () => {
  const now = new Date(Date.UTC(2026, 9, 18));

  it("accepte une vraie date proche", () => {
    assert.deepEqual(parseReleaseDate("2026-10-31", now), { ok: true, value: "2026-10-31" });
    assert.deepEqual(parseReleaseDate("2020-02-29", now), { ok: true, value: "2020-02-29" });
  });

  it("refuse une date qui n'existe pas ou mal écrite", () => {
    assert.equal(parseReleaseDate("2026-02-30", now).ok, false);
    assert.equal(parseReleaseDate("2026-13-01", now).ok, false);
    assert.equal(parseReleaseDate("31/10/2026", now).ok, false);
    assert.equal(parseReleaseDate("2021-02-29", now).ok, false);
  });

  it("refuse une date trop ancienne ou trop lointaine", () => {
    assert.equal(parseReleaseDate("1899-12-31", now).ok, false);
    assert.equal(parseReleaseDate("2029-01-01", now).ok, false);
    assert.equal(parseReleaseDate("2028-10-18", now).ok, true);
  });
});

describe("parseReleaseDetails", () => {
  const now = new Date(Date.UTC(2026, 9, 18));

  it("absent = inchangé, vide ou null = effacé", () => {
    const result = parseReleaseDetails({ description: "  Hello  ", label: "", copyright_line: null, release_date: "" }, now);
    assert.deepEqual(result, {
      ok: true,
      value: { description: "Hello", label: null, copyright_line: null, release_date: null },
    });
    assert.deepEqual(parseReleaseDetails({}, now), { ok: true, value: {} });
  });

  it("garde les retours à la ligne d'une description", () => {
    const result = parseReleaseDetails({ description: "Line one\nLine two" }, now);
    assert.deepEqual(result, { ok: true, value: { description: "Line one\nLine two" } });
  });

  it("refuse un texte trop long, un type inattendu ou une date fausse", () => {
    assert.equal(parseReleaseDetails({ description: "a".repeat(1001) }, now).ok, false);
    assert.equal(parseReleaseDetails({ label: "a".repeat(81) }, now).ok, false);
    assert.equal(parseReleaseDetails({ copyright_line: "a".repeat(121) }, now).ok, false);
    assert.equal(parseReleaseDetails({ label: 12 }, now).ok, false);
    assert.equal(parseReleaseDetails({ release_date: "soon" }, now).ok, false);
    assert.equal(parseReleaseDetails({ label: "bad\u0000label" }, now).ok, false);
    assert.equal(parseReleaseDetails(null, now).ok, false);
    assert.equal(parseReleaseDetails([], now).ok, false);
  });
});
