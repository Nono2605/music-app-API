import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DUPLICATE_FILE_MESSAGE, findForeignDuplicate, type DuplicateDb } from "./duplicateFile";

type Row = Record<string, string>;

// Un faux client avec les deux tables, qui applique les filtres demandés.
function fakeDb(tables: { track_files: Row[]; tracks: Row[] }, failOn?: string): DuplicateDb {
  return {
    from(table: string) {
      return {
        select() {
          let rows = [...(tables as Record<string, Row[]>)[table]];
          const query = {
            eq(column: string, value: unknown) { rows = rows.filter((r) => r[column] === value); return query; },
            neq(column: string, value: unknown) { rows = rows.filter((r) => r[column] !== value); return query; },
            in(column: string, values: unknown[]) { rows = rows.filter((r) => values.includes(r[column])); return query; },
            limit(count: number) { rows = rows.slice(0, count); return query; },
            then<R1, R2>(onfulfilled: (v: { data: Row[] | null; error: unknown }) => R1, onrejected?: (e: unknown) => R2) {
              const result = failOn === table ? { data: null, error: { message: "boom" } } : { data: rows, error: null };
              return Promise.resolve(result).then(onfulfilled, onrejected);
            },
          };
          return query as never;
        },
      };
    },
  };
}

const tables = {
  track_files: [
    { id: "f1", track_id: "t1", checksum: "abc" },
    { id: "f2", track_id: "t2", checksum: "abc" },
    { id: "f3", track_id: "t3", checksum: "zzz" },
  ],
  tracks: [
    { id: "t1", artist_id: "A" },
    { id: "t2", artist_id: "B" },
    { id: "t3", artist_id: "A" },
  ],
};

describe("findForeignDuplicate", () => {
  it("trouve le même fichier chez un autre artiste", async () => {
    const found = await findForeignDuplicate("abc", "A", fakeDb(tables));
    assert.deepEqual(found, { trackId: "t2", trackFileId: "f2" });
  });

  it("laisse un artiste réutiliser son propre fichier", async () => {
    const own = { ...tables, tracks: [{ id: "t1", artist_id: "A" }, { id: "t2", artist_id: "A" }, { id: "t3", artist_id: "A" }] };
    assert.equal(await findForeignDuplicate("abc", "A", fakeDb(own)), null);
  });

  it("aucune correspondance : null", async () => {
    assert.equal(await findForeignDuplicate("inconnu", "A", fakeDb(tables)), null);
  });

  it("un fichier qui n'existe que chez le même artiste : null", async () => {
    assert.equal(await findForeignDuplicate("zzz", "A", fakeDb(tables)), null);
  });

  it("si la vérification échoue, l'envoi est laissé passer (null) plutôt que bloqué", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(await findForeignDuplicate("abc", "A", fakeDb(tables, "track_files")), null);
      assert.equal(await findForeignDuplicate("abc", "A", fakeDb(tables, "tracks")), null);
    } finally {
      console.error = original;
    }
  });

  it("le message ne révèle ni l'artiste ni le morceau", () => {
    assert.doesNotMatch(DUPLICATE_FILE_MESSAGE, /artist [A-Z0-9]|track [a-z0-9]/i);
    assert.match(DUPLICATE_FILE_MESSAGE, /already on Vynl/);
  });
});
