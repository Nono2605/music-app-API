import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlockedDb } from "./blockedFiles";
import type { DuplicateDb } from "./duplicateFile";
import { blockedAudioScanner, duplicateAudioScanner, similarTitleScanner, type ScanContext } from "./scanners";
import { findSimilarTracks, normalizeTitle, type TitleDb, type TrackLite } from "./similarTitle";

type Row = Record<string, string | number | null>;

// Un faux client à tables en mémoire, qui applique les filtres demandés ; `failOn` : cette table répond en erreur.
function fakeDb(tables: Record<string, Row[]>, failOn?: string) {
  return {
    from(table: string) {
      return {
        select() {
          let rows = [...(tables[table] ?? [])];
          const query = {
            eq(column: string, value: unknown) { rows = rows.filter((r) => r[column] === value); return query; },
            neq(column: string, value: unknown) { rows = rows.filter((r) => r[column] !== value); return query; },
            in(column: string, values: unknown[]) { rows = rows.filter((r) => values.includes(r[column])); return query; },
            is(column: string, value: null) { rows = rows.filter((r) => (r[column] ?? null) === value); return query; },
            ilike(column: string, pattern: string) {
              rows = rows.filter((r) => String(r[column]).toLowerCase() === pattern.toLowerCase());
              return query;
            },
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

const HASH = "cd".repeat(32);
const context = (overrides: Partial<ScanContext["track"]> = {}, files: ScanContext["files"] = [{ id: "f1", checksum: HASH, storage_key: "k" }]): ScanContext => ({
  track: { id: "t1", title: "Nova", duration_seconds: 200, artist_id: "a1", ...overrides },
  files,
});

describe("duplicateAudioScanner", () => {
  it("le même fichier chez un autre artiste : fail, avec le morceau et l'artiste trouvés", async () => {
    const db = fakeDb({
      track_files: [{ id: "f9", track_id: "t9", checksum: HASH }],
      tracks: [{ id: "t9", artist_id: "a2" }],
    });

    const [outcome] = await duplicateAudioScanner(db as unknown as DuplicateDb).run(context());

    assert.equal(outcome.result, "fail");
    assert.equal(outcome.matched_track_id, "t9");
    assert.equal(outcome.matched_artist_id, "a2");
    assert.equal(outcome.track_file_id, "f1");
  });

  it("le même fichier chez le MÊME artiste (un single puis l'album) : ok", async () => {
    const db = fakeDb({
      track_files: [{ id: "f9", track_id: "t9", checksum: HASH }],
      tracks: [{ id: "t9", artist_id: "a1" }],
    });

    const [outcome] = await duplicateAudioScanner(db as unknown as DuplicateDb).run(context());

    assert.equal(outcome.result, "ok");
  });

  it("aucun fichier de même empreinte : ok ; aucune empreinte à comparer : ok", async () => {
    const db = fakeDb({ track_files: [], tracks: [] });
    const scanner = duplicateAudioScanner(db as unknown as DuplicateDb);

    assert.equal((await scanner.run(context()))[0].result, "ok");
    assert.equal((await scanner.run(context({}, [{ id: "f1", checksum: null, storage_key: "k" }])))[0].result, "ok");
  });

  it("le même fichier chez un artiste SUPPRIMÉ : ok (comme à l'envoi)", async () => {
    const db = fakeDb({
      track_files: [{ id: "f9", track_id: "t9", checksum: HASH }],
      tracks: [{ id: "t9", artist_id: "a2", artists: { anonymized_at: "2026-10-20T00:00:00Z" } } as unknown as Row],
    });

    const [outcome] = await duplicateAudioScanner(db as unknown as DuplicateDb).run(context());

    assert.equal(outcome.result, "ok");
  });

  it("un fichier purgé du stockage ne compte pas : ok", async () => {
    const db = fakeDb({
      track_files: [{ id: "f9", track_id: "t9", checksum: HASH, purged_at: "2026-10-21T00:00:00Z" }],
      tracks: [{ id: "t9", artist_id: "a2" }],
    });

    assert.equal((await duplicateAudioScanner(db as unknown as DuplicateDb).run(context()))[0].result, "ok");
  });

  it("une panne de base LÈVE l'erreur (jamais « ok » en silence)", async () => {
    const db = fakeDb({ track_files: [], tracks: [] }, "track_files");

    await assert.rejects(() => duplicateAudioScanner(db as unknown as DuplicateDb).run(context()));
  });
});

describe("blockedAudioScanner", () => {
  const blockedDb = (rows: Row[], error?: unknown): BlockedDb => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, value: unknown) => ({
          limit: () => Promise.resolve(error ? { data: null, error } : { data: rows.filter((r) => r.checksum === value), error: null }),
        }),
      }),
    }),
  } as unknown as BlockedDb);

  it("un fichier de la liste de blocage : fail", async () => {
    const [outcome] = await blockedAudioScanner(blockedDb([{ checksum: HASH }])).run(context());
    assert.equal(outcome.result, "fail");
    assert.equal(outcome.track_file_id, "f1");
  });

  it("un fichier absent de la liste : ok", async () => {
    const [outcome] = await blockedAudioScanner(blockedDb([])).run(context());
    assert.equal(outcome.result, "ok");
  });

  it("la liste n'existe pas encore (migration pas appliquée) : ok ; toute autre panne lève l'erreur", async () => {
    assert.equal((await blockedAudioScanner(blockedDb([], { code: "42P01" })).run(context()))[0].result, "ok");
    await assert.rejects(() => blockedAudioScanner(blockedDb([], { code: "XX000", message: "boom" })).run(context()));
  });
});

describe("similarTitleScanner", () => {
  const other = (overrides: Row = {}): Row => ({ id: "t9", title: "Nova", duration_seconds: 201, artist_id: "a2", ...overrides });

  it("même titre et durée voisine chez un autre artiste : warn", async () => {
    const db = fakeDb({ tracks: [other()] });

    const [outcome] = await similarTitleScanner(db as unknown as TitleDb).run(context());

    assert.equal(outcome.result, "warn");
    assert.equal(outcome.matched_track_id, "t9");
    assert.equal(outcome.matched_artist_id, "a2");
  });

  it("durée trop différente, ou même artiste : ok", async () => {
    const scanner = (rows: Row[]) => similarTitleScanner(fakeDb({ tracks: rows }) as unknown as TitleDb);

    assert.equal((await scanner([other({ duration_seconds: 260 })]).run(context()))[0].result, "ok");
    assert.equal((await scanner([other({ artist_id: "a1" })]).run(context()))[0].result, "ok");
  });

  it("sans durée connue : rien à comparer, ok", async () => {
    const [outcome] = await similarTitleScanner(fakeDb({ tracks: [other()] }) as unknown as TitleDb).run(context({ duration_seconds: null }));
    assert.equal(outcome.result, "ok");
  });

  it("une panne de base LÈVE l'erreur", async () => {
    await assert.rejects(() => similarTitleScanner(fakeDb({ tracks: [] }, "tracks") as unknown as TitleDb).run(context()));
  });
});

describe("normalizeTitle et findSimilarTracks", () => {
  const track: TrackLite = { id: "t1", title: "Café Nuit!", duration_seconds: 100, artist_id: "a1" };

  it("ignore la casse, les accents et la ponctuation", () => {
    assert.equal(normalizeTitle("  Café   NUIT! "), "cafe nuit");
  });

  it("garde la tolérance de 2 secondes, inclusive", () => {
    const candidate = (duration: number): TrackLite => ({ id: "t2", title: "cafe nuit", duration_seconds: duration, artist_id: "a2" });
    assert.equal(findSimilarTracks(track, [candidate(102)]).length, 1);
    assert.equal(findSimilarTracks(track, [candidate(103)]).length, 0);
  });
});
