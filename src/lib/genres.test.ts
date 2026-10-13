import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GenresUnavailableError,
  genreProblem,
  isActiveGenre,
  listGenres,
  parseGenreInput,
  readTrackGenre,
  readTrackGenres,
  releaseGenreProblem,
  writeTrackGenre,
  type GenreDb,
} from "./genres";

describe("parseGenreInput", () => {
  it("accepte un code de genre", () => {
    assert.deepEqual(parseGenreInput("hip_hop_rap"), { ok: true, value: "hip_hop_rap" });
    assert.deepEqual(parseGenreInput("pop"), { ok: true, value: "pop" });
  });
  it("null ou chaîne vide : retire le genre", () => {
    assert.deepEqual(parseGenreInput(null), { ok: true, value: null });
    assert.deepEqual(parseGenreInput(""), { ok: true, value: null });
  });
  it("refuse tout le reste : libellés, majuscules, injection, types", () => {
    for (const bad of ["Hip-hop", "POP", "pop ", " pop", "a", "pop; drop table tracks", "x".repeat(40), 1, true, {}, [], undefined]) {
      assert.equal(parseGenreInput(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("genreProblem / releaseGenreProblem", () => {
  it("un morceau sans genre ne part pas en relecture", () => {
    assert.match(genreProblem(null) ?? "", /Choose a genre/);
    assert.match(genreProblem("") ?? "", /Choose a genre/);
    assert.equal(genreProblem("pop"), null);
  });
  it("une release : nomme les morceaux sans genre, abrège au-delà de trois", () => {
    assert.equal(releaseGenreProblem([{ title: "A", genre_code: "pop" }]), null);
    assert.match(releaseGenreProblem([{ title: "A" }, { title: "B", genre_code: "pop" }]) ?? "", /1 track has no genre yet: “A”/);
    const five = ["A", "B", "C", "D", "E"].map((title) => ({ title, genre_code: null }));
    assert.match(releaseGenreProblem(five) ?? "", /5 tracks have no genre yet: “A”, “B”, “C” and 2 more/);
  });
});

// Un faux client : chaque table renvoie ce qu'on lui donne, ou une erreur.
function fakeDb(responses: Record<string, { data?: Record<string, unknown>[]; error?: unknown }>, updated: unknown[] = []): GenreDb {
  return {
    from(table: string) {
      const response = responses[table] ?? { data: [] };
      const query = {
        eq: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        then: (resolve: (v: { data: Record<string, unknown>[] | null; error: unknown }) => unknown) =>
          Promise.resolve({ data: response.error ? null : (response.data ?? []), error: response.error ?? null }).then(resolve),
      };
      return {
        select: () => query as never,
        update: (values: Record<string, unknown>) => ({
          eq: async () => (updated.push([table, values]), { error: response.error ?? null }),
        }),
      };
    },
  };
}

describe("accès à la base (avant et après la migration)", () => {
  it("listGenres rend la liste ; une table absente = indisponible", async () => {
    assert.deepEqual(await listGenres(fakeDb({ genres: { data: [{ code: "pop", label: "Pop" }] } })), [{ code: "pop", label: "Pop" }]);
    await assert.rejects(listGenres(fakeDb({ genres: { error: { code: "PGRST205" } } })), GenresUnavailableError);
    await assert.rejects(listGenres(fakeDb({ genres: { error: { code: "XX000" } } })), (e) => !(e instanceof GenresUnavailableError));
  });

  it("isActiveGenre", async () => {
    assert.equal(await isActiveGenre("pop", fakeDb({ genres: { data: [{ code: "pop" }] } })), true);
    assert.equal(await isActiveGenre("nope", fakeDb({ genres: { data: [] } })), false);
  });

  it("readTrackGenre : le code, null sans genre, undefined si la colonne manque", async () => {
    assert.equal(await readTrackGenre("t", fakeDb({ tracks: { data: [{ genre_code: "jazz" }] } })), "jazz");
    assert.equal(await readTrackGenre("t", fakeDb({ tracks: { data: [{ genre_code: null }] } })), null);
    assert.equal(await readTrackGenre("t", fakeDb({ tracks: { data: [] } })), null);
    assert.equal(await readTrackGenre("t", fakeDb({ tracks: { error: { code: "42703" } } })), undefined);
  });

  it("readTrackGenres : une table de correspondance, null si la colonne manque", async () => {
    const map = await readTrackGenres(["a", "b"], fakeDb({ tracks: { data: [{ id: "a", genre_code: "pop" }, { id: "b", genre_code: null }] } }));
    assert.equal(map?.get("a"), "pop");
    assert.equal(map?.get("b"), null);
    assert.equal(await readTrackGenres(["a"], fakeDb({ tracks: { error: { code: "42703" } } })), null);
    assert.equal((await readTrackGenres([], fakeDb({})))?.size, 0);
  });

  it("writeTrackGenre écrit genre_code ; une colonne absente = indisponible", async () => {
    const updated: unknown[] = [];
    await writeTrackGenre("t", "pop", fakeDb({}, updated));
    assert.deepEqual(updated, [["tracks", { genre_code: "pop" }]]);
    await assert.rejects(writeTrackGenre("t", "pop", fakeDb({ tracks: { error: { code: "PGRST204" } } })), GenresUnavailableError);
  });
});
