import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_FORMAT_VERSION,
  attachNames,
  buildExport,
  collectSections,
  exportAccount,
  type ExportDb,
  type Row,
} from "./accountExport";

// Un faux client : des tables en mémoire, avec les filtres et le tri demandés.
function fakeDb(tables: Record<string, Row[]>, errors: Record<string, unknown> = {}): ExportDb {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const wanted = columns.split(",").map((c) => c.trim());
          let rows = [...(tables[table] ?? [])];
          const query = {
            eq(column: string, value: unknown) { rows = rows.filter((r) => r[column] === value); return query; },
            in(column: string, values: unknown[]) { rows = rows.filter((r) => values.includes(r[column])); return query; },
            order(column: string, options?: { ascending: boolean }) {
              const dir = options?.ascending === false ? -1 : 1;
              rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -dir : String(a[column]) > String(b[column]) ? dir : 0));
              return query;
            },
            limit(count: number) { rows = rows.slice(0, count); return query; },
            then(resolve: (v: { data: Row[] | null; error: unknown }) => unknown) {
              const projected = rows.map((r) => Object.fromEntries(wanted.filter((c) => c in r).map((c) => [c, r[c]])));
              return Promise.resolve({ data: errors[table] ? null : projected, error: errors[table] ?? null }).then(resolve);
            },
          };
          return query as never;
        },
      };
    },
  };
}

const ME = "user-1";
const tables: Record<string, Row[]> = {
  users: [{ id: ME, email: "me@example.com", role: "listener", status: "active", created_at: "2026-01-01" }, { id: "other", email: "x@example.com" }],
  profiles: [{ user_id: ME, username: "moi" }, { user_id: "other", username: "autre" }],
  consents: [{ user_id: ME, purpose: "terms", granted: true, created_at: "2026-01-02" }, { user_id: "other", purpose: "terms", granted: false, created_at: "2026-01-02" }],
  library: [{ user_id: ME, item_type: "track", item_id: "t1", added_at: "2026-02-01" }],
  playlists: [{ id: "p1", owner_id: ME, title: "Ma liste", created_at: "2026-02-02" }, { id: "p2", owner_id: "other", title: "Pas à moi", created_at: "2026-02-02" }],
  playlist_tracks: [{ playlist_id: "p1", track_id: "t1", position: 1 }, { playlist_id: "p2", track_id: "t2", position: 1 }],
  plays: [
    { user_id: ME, track_id: "t1", artist_id: "a1", started_at: "2026-03-01", ip_hash: "SECRET", client_session_id: "c" },
    { user_id: ME, track_id: "t1", artist_id: "a1", started_at: "2026-03-02", ip_hash: "SECRET" },
    { user_id: "other", track_id: "t9", artist_id: "a9", started_at: "2026-03-03" },
  ],
  tracks: [{ id: "t1", title: "Premier", artist_id: "a1" }, { id: "t9", title: "Autre", artist_id: "a9" }],
  artists: [{ id: "a1", name: "Artiste Un", user_id: "creator-1" }],
};

describe("collectSections : seulement les données du compte", () => {
  it("ne ramène jamais les lignes d'un autre compte", async () => {
    const sections = await collectSections(ME, fakeDb(tables));
    assert.equal(sections.account.rows.length, 1);
    assert.equal(sections.account.rows[0].email, "me@example.com");
    assert.deepEqual(sections.profile.rows.map((r) => r.username), ["moi"]);
    assert.equal(sections.consents.rows.length, 1);
    assert.deepEqual(sections.playlists.rows.map((r) => r.id), ["p1"]);
    assert.deepEqual(sections.playlist_tracks.rows.map((r) => r.track_id), ["t1"]);
    assert.equal(sections.plays.rows.length, 2);
  });

  it("joint le titre du morceau et le nom de l'artiste aux écoutes", async () => {
    const sections = await collectSections(ME, fakeDb(tables));
    assert.equal(sections.plays.rows[0].track_title, "Premier");
    assert.equal(sections.plays.rows[0].artist_name, "Artiste Un");
  });

  it("un morceau ou un artiste introuvable : null, pas d'invention", async () => {
    const withUnknown = { ...tables, plays: [{ user_id: ME, track_id: "inconnu", artist_id: "inconnu", started_at: "2026-03-05" }] };
    const sections = await collectSections(ME, fakeDb(withUnknown));
    assert.equal(sections.plays.rows[0].track_title, null);
    assert.equal(sections.plays.rows[0].artist_name, null);
  });

  it("les écoutes sont les plus récentes d'abord", async () => {
    const sections = await collectSections(ME, fakeDb(tables));
    assert.deepEqual(sections.plays.rows.map((r) => r.started_at), ["2026-03-02", "2026-03-01"]);
  });

  it("une table absente est marquée « unavailable », sans faire échouer l'export", async () => {
    const sections = await collectSections(ME, fakeDb(tables, { consents: { code: "42P01" }, tracks: { code: "42703" } }));
    assert.equal(sections.consents.unavailable, true);
    assert.deepEqual(sections.consents.rows, []);
  });

  it("toute AUTRE erreur fait échouer l'export (jamais un export incomplet présenté comme complet)", async () => {
    await assert.rejects(collectSections(ME, fakeDb(tables, { library: { code: "XX000", message: "boom" } })));
  });
});

describe("buildExport", () => {
  it("ne contient ni empreinte d'IP, ni identifiant de session, ni donnée de sécurité", async () => {
    const out = await exportAccount(ME, new Date("2026-10-13T10:00:00Z"), fakeDb(tables));
    // Les notes expliquent ce qui est exclu (elles citent ces mots) : on contrôle les DONNÉES seulement.
    const { notes: _notes, ...data } = out;
    void _notes;
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /SECRET/);
    assert.doesNotMatch(text, /ip_hash|client_session_id|fraud/);
    assert.doesNotMatch(text, /autre|Pas à moi|x@example.com/, "aucune donnée d'un autre compte");
  });

  it("donne la version, la date, l'identifiant et les notes", async () => {
    const out = await exportAccount(ME, new Date("2026-10-13T10:00:00Z"), fakeDb(tables));
    assert.equal(out.format_version, EXPORT_FORMAT_VERSION);
    assert.equal(out.generated_at, "2026-10-13T10:00:00.000Z");
    assert.equal(out.account_id, ME);
    assert.ok(Array.isArray(out.notes) && (out.notes as string[]).length >= 3);
  });

  it("les sections uniques sont des objets (ou null), les autres des listes", async () => {
    const out = await exportAccount(ME, new Date(), fakeDb(tables));
    assert.equal((out.account as Row).email, "me@example.com");
    assert.equal(out.creator_onboarding, null);
    assert.ok(Array.isArray(out.library));
  });

  it("signale ce qui est tronqué ou indisponible", () => {
    const out = buildExport({
      userId: ME,
      generatedAt: new Date(),
      sections: { plays: { rows: [], truncated: true }, consents: { rows: [], unavailable: true }, library: { rows: [] } },
    });
    assert.deepEqual(out.meta, { truncated: ["plays"], unavailable: ["consents"] });
  });
});

describe("attachNames", () => {
  it("laisse null quand le nom est inconnu", () => {
    const rows = attachNames([{ track_id: "t", artist_id: "a" }], new Map(), new Map());
    assert.deepEqual(rows, [{ track_id: "t", artist_id: "a", track_title: null, artist_name: null }]);
  });
});
