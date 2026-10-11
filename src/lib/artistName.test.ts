import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIST_NAME_MAX,
  classifyArtistInsertError,
  normalizeArtistName,
  suggestArtistNames,
  validateArtistName,
  type ArtistNameProblem,
} from "./artistName";

const problem = (raw: unknown): ArtistNameProblem | "ok" => {
  const v = validateArtistName(raw);
  return v.ok ? "ok" : v.code;
};

describe("normalizeArtistName", () => {
  it("espaces multiples et bords réduits", () => {
    assert.equal(normalizeArtistName("  Neon \t  Tides \n"), "Neon Tides");
  });
  it("apostrophes et tirets typographiques ramenés à ' et -", () => {
    assert.equal(normalizeArtistName("Guns N’ Roses"), "Guns N' Roses");
    assert.equal(normalizeArtistName("Jay–Z"), "Jay-Z");
  });
  it("formes « larges » ramenées à la normale (NFKC)", () => {
    assert.equal(normalizeArtistName("ＲＡＦＡＬＥ"), "RAFALE");
  });
  it("ne plante pas sur n'importe quoi", () => {
    assert.equal(normalizeArtistName(undefined), "");
    assert.equal(normalizeArtistName(null), "");
    assert.equal(normalizeArtistName(42), "42");
  });
});

describe("validateArtistName : noms acceptés", () => {
  for (const name of [
    "RAFALE",
    "TheCreator",
    "Jay-Z",
    "Guns N' Roses",
    "2Pac",
    "Blink-182",
    "50 Cent",
    "Sigur Rós",
    "Beyoncé",
    "Ünal",
    "坂本龍一",
    "Мария", // écriture cyrillique seule : permise
    "Dr. Dre",
    "Q&A",
    "Hey!",
    "snake_case",
    "ab",
  ]) {
    it(name, () => assert.equal(problem(name), "ok"));
  }
  it("rend le nom normalisé", () => {
    const v = validateArtistName("  Neon   Tides ");
    assert.deepEqual(v, { ok: true, name: "Neon Tides" });
  });
});

describe("validateArtistName : noms refusés", () => {
  const cases: [string, unknown, ArtistNameProblem][] = [
    ["vide", "", "required"],
    ["espaces seuls", "   ", "required"],
    ["absent", undefined, "required"],
    ["1 caractère", "A", "too_short"],
    ["41 caractères", "a".repeat(ARTIST_NAME_MAX + 1), "too_long"],
    ["@ dans le nom", "@rafale", "characters"],
    ["slash", "AC/DC", "characters"],
    ["emoji", "Neon 😀", "characters"],
    ["dollar", "Ke$ha", "characters"],
    ["balises", "<b>Rafale</b>", "characters"],
    ["commence par un séparateur", "-Rafale", "starts_badly"],
    ["séparateurs seuls", "!!!", "starts_badly"],
    ["chiffres seuls", "1234", "no_letters"],
    ["adresse web (www)", "www.rafale", "link"],
    ["adresse web (http)", "http://x", "characters"],
    ["nom de domaine", "rafale.com", "link"],
    ["a cyrillique dans un nom latin", "Rаfale", "mixed_scripts"],
    ["lettre grecque dans un nom latin", "Alpha Βeta", "mixed_scripts"],
  ];
  for (const [label, input, expected] of cases) {
    it(`${label} -> ${expected}`, () => assert.equal(problem(input), expected));
  }

  it("un message lisible accompagne chaque refus", () => {
    const v = validateArtistName("A");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.message, /at least 2 characters/);
  });

  it("la longueur se compte en caractères, pas en unités UTF-16 (emoji hors jeu)", () => {
    // 40 idéogrammes (chacun 1 caractère) passent ; 41 non
    assert.equal(problem("坂".repeat(40)), "ok");
    assert.equal(problem("坂".repeat(41)), "too_long");
  });
});

describe("classifyArtistInsertError", () => {
  const dup = (index: string) => ({
    code: "23505",
    message: `duplicate key value violates unique constraint "${index}"`,
  });
  it("distingue le nom, le compte et le slug d'après l'index cité", () => {
    assert.equal(classifyArtistInsertError(dup("artists_name_key_unique")), "name_taken");
    assert.equal(classifyArtistInsertError(dup("artists_user_id_unique")), "already_has_artist");
    assert.equal(classifyArtistInsertError(dup("artists_slug_key")), "slug_taken");
  });
  it("reconnaît un nom réservé et un mauvais format refusés par la base", () => {
    assert.equal(
      classifyArtistInsertError({ code: "23514", message: 'ARTIST_NAME_RESERVED: "Vynl" is a reserved name' }),
      "name_reserved"
    );
    assert.equal(
      classifyArtistInsertError({ code: "23514", message: 'new row violates check constraint "artists_name_format"' }),
      "name_format"
    );
  });
  it("le reste est « other » (donc relancé comme une vraie erreur)", () => {
    assert.equal(classifyArtistInsertError({ code: "42P01", message: "relation does not exist" }), "other");
    assert.equal(classifyArtistInsertError(null), "other");
    assert.equal(classifyArtistInsertError({ code: "23514", message: "autre contrainte" }), "other");
  });
});

describe("suggestArtistNames", () => {
  it("propose le nom suivi d'un mot neutre, jamais « Official »", () => {
    const s = suggestArtistNames("Rafale");
    assert.ok(s.includes("Rafale Music"));
    assert.ok(!s.some((x) => /official/i.test(x)));
  });
  it("n'en propose aucune qui dépasse la longueur permise", () => {
    assert.deepEqual(suggestArtistNames("a".repeat(38)), []);
    for (const s of suggestArtistNames("Neon Tides")) assert.equal(validateArtistName(s).ok, true);
  });
});
