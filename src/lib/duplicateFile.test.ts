import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DUPLICATE_FILE_MESSAGE, findForeignDuplicate, lookupForeignDuplicate, type DuplicateDb } from "./duplicateFile";

type Row = Record<string, unknown>;

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
            is(column: string, value: null) { rows = rows.filter((r) => (r[column] ?? null) === value); return query; },
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
    assert.deepEqual(found, { trackId: "t2", trackFileId: "f2", artistId: "B" });
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

  it("un morceau ARCHIVÉ d'un autre artiste actif compte encore : c'est toujours sa copie", async () => {
    const archived = { ...tables, tracks: [{ id: "t1", artist_id: "A" }, { id: "t2", artist_id: "B", status: "archived" }, { id: "t3", artist_id: "A" }] };
    assert.equal((await findForeignDuplicate("abc", "A", fakeDb(archived)))?.trackId, "t2");
  });

  it("un artiste SUPPRIMÉ (page anonymisée) ne bloque plus personne : on peut renvoyer sa propre musique depuis un nouveau compte", async () => {
    const gone = { ...tables, tracks: [{ id: "t1", artist_id: "A" }, { id: "t2", artist_id: "B", artists: { anonymized_at: "2026-10-20T00:00:00Z" } }, { id: "t3", artist_id: "A" }] };
    assert.equal(await findForeignDuplicate("abc", "A", fakeDb(gone)), null);
    // La relation intégrée peut aussi arriver sous forme de liste.
    const asList = { ...tables, tracks: [{ id: "t1", artist_id: "A" }, { id: "t2", artist_id: "B", artists: [{ anonymized_at: "2026-10-20T00:00:00Z" }] }, { id: "t3", artist_id: "A" }] };
    assert.equal(await findForeignDuplicate("abc", "A", fakeDb(asList)), null);
  });

  it("un artiste actif (anonymized_at vide) bloque toujours", async () => {
    const active = { ...tables, tracks: [{ id: "t1", artist_id: "A" }, { id: "t2", artist_id: "B", artists: { anonymized_at: null } }, { id: "t3", artist_id: "A" }] };
    assert.equal((await findForeignDuplicate("abc", "A", fakeDb(active)))?.trackId, "t2");
  });

  it("un fichier PURGÉ du stockage n'existe plus : il ne bloque pas", async () => {
    const purged = { ...tables, track_files: [{ id: "f1", track_id: "t1", checksum: "abc" }, { id: "f2", track_id: "t2", checksum: "abc", purged_at: "2026-10-21T00:00:00Z" }] };
    assert.equal(await findForeignDuplicate("abc", "A", fakeDb(purged)), null);
  });

  it("si un artiste supprimé ET un artiste actif ont le fichier, c'est l'actif qui est rendu", async () => {
    const both = {
      track_files: [{ id: "f2", track_id: "t2", checksum: "abc" }, { id: "f4", track_id: "t4", checksum: "abc" }],
      tracks: [{ id: "t2", artist_id: "B", artists: { anonymized_at: "2026-10-20T00:00:00Z" } }, { id: "t4", artist_id: "C", artists: { anonymized_at: null } }],
    };
    assert.deepEqual(await findForeignDuplicate("abc", "A", fakeDb(both)), { trackId: "t4", trackFileId: "f4", artistId: "C" });
  });

  it("lookupForeignDuplicate LÈVE l'erreur de la base (le contrôle automatique en a besoin) ; findForeignDuplicate, lui, laisse passer", async () => {
    await assert.rejects(() => lookupForeignDuplicate("abc", "A", fakeDb(tables, "tracks")), (err) => (err as { message?: string }).message === "boom");
  });

  it("le message ne révèle ni l'artiste ni le morceau", () => {
    assert.doesNotMatch(DUPLICATE_FILE_MESSAGE, /artist [A-Z0-9]|track [a-z0-9]/i);
    assert.match(DUPLICATE_FILE_MESSAGE, /already on Vynl/);
  });
});
