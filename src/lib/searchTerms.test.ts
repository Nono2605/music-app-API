import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrackSearchFilter,
  cleanSearch,
  genreCodesMatching,
  genreFilter,
  parseGenreParam,
  parseTagParam,
} from "./searchTerms";

const genres = [
  { code: "pop", label: "Pop" },
  { code: "hip_hop_rap", label: "Hip-hop / Rap" },
  { code: "asian_pop", label: "K-pop / J-pop" },
  { code: "rock", label: "Rock" },
];

describe("cleanSearch", () => {
  it("retire ce qui aurait un sens dans un filtre ou un LIKE", () => {
    assert.equal(cleanSearch('a,b(c)"d{e}\\f*g%h_i'), "a b c d e f g h i");
    assert.equal(cleanSearch("x,status.eq.draft"), "x status.eq.draft");
  });

  it("espaces simples, bornée, et tolère un type inattendu", () => {
    assert.equal(cleanSearch("  late    night  "), "late night");
    assert.equal(cleanSearch("a".repeat(300)).length, 100);
    assert.equal(cleanSearch(undefined), "");
    assert.equal(cleanSearch(["x"]), "");
    assert.equal(cleanSearch("tab\tsplit\nnewline"), "tab split newline");
  });
});

describe("parseGenreParam et parseTagParam", () => {
  it("un genre est un code de la liste fermée", () => {
    assert.equal(parseGenreParam("hip_hop_rap"), "hip_hop_rap");
    assert.equal(parseGenreParam("Hip Hop"), null);
    assert.equal(parseGenreParam("pop,status.eq.draft"), null);
    assert.equal(parseGenreParam(["pop"]), null);
  });

  it("un style est mis en forme comme à l'enregistrement", () => {
    assert.equal(parseTagParam("  #Late   Night "), "late night");
    assert.equal(parseTagParam("x"), null);
    assert.equal(parseTagParam("<b>"), null);
    assert.equal(parseTagParam(12), null);
  });
});

describe("genreCodesMatching", () => {
  it("trouve les genres dont le libellé contient le terme", () => {
    assert.deepEqual(genreCodesMatching("hop", genres), ["hip_hop_rap"]);
    assert.deepEqual(genreCodesMatching("POP", genres), ["pop", "asian_pop"]);
  });

  it("le code lui-même compte", () => {
    assert.deepEqual(genreCodesMatching("hip_hop_rap", genres), ["hip_hop_rap"]);
  });

  it("moins de 3 lettres : rien, pour ne pas ramener la moitié de la liste", () => {
    assert.deepEqual(genreCodesMatching("po", genres), []);
  });
});

describe("buildTrackSearchFilter", () => {
  const id = "3f2b8c1e-5d4a-4b7e-9c3d-0a1b2c3d4e5f";

  it("le titre, et le même mot comme style exact quand il en a la forme", () => {
    assert.equal(
      buildTrackSearchFilter({ term: "midnight drive", genreCodes: [], creditedTrackIds: [] }),
      'title.ilike.%midnight drive%,tags.cs.{"midnight drive"}'
    );
  });

  it("le titre seul quand le terme ne peut pas être un style", () => {
    assert.equal(buildTrackSearchFilter({ term: "a", genreCodes: [], creditedTrackIds: [] }), "title.ilike.%a%");
  });

  it("ajoute le style, les genres et les morceaux d'un artiste crédité", () => {
    const filter = buildTrackSearchFilter({ term: "dark pop", genreCodes: ["pop", "asian_pop"], creditedTrackIds: [id] });
    assert.equal(
      filter,
      `title.ilike.%dark pop%,tags.cs.{"dark pop"},genre_code.in.(pop,asian_pop),extra_genre_codes.ov.{pop,asian_pop},id.in.(${id})`
    );
  });

  it("revérifie les codes et les identifiants : rien d'inattendu ne passe dans le filtre", () => {
    const filter = buildTrackSearchFilter({
      term: "x1",
      genreCodes: ["pop", "bad code", "a),status.eq.draft"],
      creditedTrackIds: ["not-a-uuid", `${id}),status.eq.draft`, id],
    });
    assert.ok(!filter.includes("draft"));
    assert.ok(filter.includes("genre_code.in.(pop)"));
    assert.ok(filter.endsWith(`id.in.(${id})`));
  });

  it("n'ajoute pas de style quand le terme n'en est pas un", () => {
    assert.ok(!buildTrackSearchFilter({ term: "a", genreCodes: [], creditedTrackIds: [] }).includes("tags.cs"));
  });
});

describe("genreFilter", () => {
  it("le genre principal ou l'un des autres", () => {
    assert.equal(genreFilter("jazz"), "genre_code.eq.jazz,extra_genre_codes.cs.{jazz}");
  });
});
