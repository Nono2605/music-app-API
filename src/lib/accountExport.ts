import { isMissingColumn, isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

// Export des données d'un compte (droit d'accès et de portabilité, nLPD / RGPD). Un document JSON lisible :
// ce que Vynl garde SUR CE COMPTE, table par table.
//
// Volontairement absent (dit dans `notes`) : les données de sécurité internes (scores et événements de
// fraude, journaux d'administration, empreintes d'IP, contrôles de contenu) et ce que Stripe détient
// (paiement, vérification d'identité), qui se demande à Stripe. À faire valider par le juriste (spec 16).
//
// Une section illisible parce que la table ou la colonne n'existe pas encore (migration pas appliquée) est
// marquée « unavailable » ; toute AUTRE erreur fait échouer l'export, pour ne jamais livrer un export
// incomplet en le présentant comme complet.

export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_PLAYS_LIMIT = 50_000;
export const EXPORT_TITLES_LIMIT = 2_000;
const IN_CHUNK = 100;

export type Row = Record<string, unknown>;

interface Query extends PromiseLike<{ data: Row[] | null; error: unknown }> {
  eq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(count: number): Query;
}
export interface ExportDb {
  from(table: string): { select(columns: string): Query };
}
const defaultDb = () => supabaseAdmin as unknown as ExportDb;

export interface ExportSection {
  rows: Row[];
  truncated?: boolean;
  unavailable?: boolean;
}

interface Fetch {
  table: string;
  columns: string;
  where: { column: string; value?: unknown; values?: unknown[] };
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
}

async function fetchRows(db: ExportDb, f: Fetch): Promise<ExportSection> {
  let query = db.from(f.table).select(f.columns);
  query = f.where.values ? query.in(f.where.column, f.where.values) : query.eq(f.where.column, f.where.value);
  if (f.orderBy) query = query.order(f.orderBy, { ascending: f.ascending ?? true });
  if (f.limit) query = query.limit(f.limit + 1);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error) || isMissingColumn(error)) return { rows: [], unavailable: true };
    throw error;
  }
  const rows = data ?? [];
  if (f.limit && rows.length > f.limit) return { rows: rows.slice(0, f.limit), truncated: true };
  return { rows };
}

// Une liste d'identifiants, interrogée par lots (une adresse de requête ne peut pas être infiniment longue).
async function fetchByIds(db: ExportDb, table: string, columns: string, idColumn: string, ids: string[], extra?: Partial<Fetch>) {
  const rows: Row[] = [];
  let unavailable = false;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = await fetchRows(db, { table, columns, where: { column: idColumn, values: ids.slice(i, i + IN_CHUNK) }, ...extra });
    if (part.unavailable) unavailable = true;
    rows.push(...part.rows);
  }
  return { rows, ...(unavailable ? { unavailable } : {}) } as ExportSection;
}

const distinct = (rows: Row[], key: string): string[] => [
  ...new Set(rows.map((row) => row[key]).filter((value): value is string => typeof value === "string")),
];

// Ajoute le titre du morceau et le nom de l'artiste à chaque écoute (les identifiants seuls ne diraient rien).
export function attachNames(plays: Row[], trackTitles: Map<string, string>, artistNames: Map<string, string>): Row[] {
  return plays.map((play) => ({
    ...play,
    track_title: trackTitles.get(String(play.track_id)) ?? null,
    artist_name: artistNames.get(String(play.artist_id)) ?? null,
  }));
}

export async function collectSections(userId: string, db: ExportDb = defaultDb()): Promise<Record<string, ExportSection>> {
  const mine = (column: string) => ({ column, value: userId });
  const sections: Record<string, ExportSection> = {};

  sections.account = await fetchRows(db, { table: "users", columns: "id, email, role, status, created_at", where: mine("id") });
  sections.profile = await fetchRows(db, {
    table: "profiles",
    columns: "username, display_name, avatar_url, bio, country, locale, explicit_content, favorite_genres, created_at",
    where: mine("user_id"),
  });
  sections.consents = await fetchRows(db, {
    table: "consents",
    columns: "purpose, granted, policy_version, source, created_at",
    where: mine("user_id"),
    orderBy: "created_at",
  });
  sections.library = await fetchRows(db, { table: "library", columns: "item_type, item_id, added_at", where: mine("user_id"), orderBy: "added_at" });
  sections.follows = await fetchRows(db, { table: "follows", columns: "artist_id, followed_user_id, created_at", where: mine("follower_id") });
  sections.subscriptions = await fetchRows(db, {
    table: "subscriptions",
    columns: "plan, status, provider, current_period_start, current_period_end, cancel_at_period_end, created_at",
    where: mine("user_id"),
    orderBy: "created_at",
  });
  sections.payments = await fetchRows(db, {
    table: "payments",
    columns: "plan, currency, gross_cents, tax_cents, refunded_cents, status, provider, provider_payment_id, paid_at",
    where: mine("user_id"),
    orderBy: "paid_at",
  });
  sections.billing_customers = await fetchRows(db, {
    table: "billing_customers",
    columns: "provider, provider_customer_id, created_at",
    where: mine("user_id"),
  });
  sections.creator_onboarding = await fetchRows(db, {
    table: "creator_onboarding",
    columns: "terms_version, terms_accepted_at, content_provenance, owns_rights, primary_genre",
    where: mine("user_id"),
  });
  sections.ai_declarations = await fetchRows(db, {
    table: "ai_declarations",
    columns: "track_id, provenance, ai_tool_names, description, status, declared_at",
    where: mine("declared_by"),
    orderBy: "declared_at",
  });

  // Playlists, puis leurs morceaux.
  sections.playlists = await fetchRows(db, {
    table: "playlists",
    columns: "id, title, description, is_public, created_at",
    where: mine("owner_id"),
    orderBy: "created_at",
  });
  sections.playlist_tracks = await fetchByIds(
    db, "playlist_tracks", "playlist_id, track_id, position, added_at", "playlist_id", distinct(sections.playlists.rows, "id")
  );

  // Historique d'écoute : les plus récentes d'abord, plafonné.
  const plays = await fetchRows(db, {
    table: "plays",
    columns: "started_at, ended_at, track_id, artist_id, validated_seconds, qualified, source_context, country_code, device_type",
    where: mine("user_id"),
    orderBy: "started_at",
    ascending: false,
    limit: EXPORT_PLAYS_LIMIT,
  });
  const trackIds = distinct(plays.rows, "track_id").slice(0, EXPORT_TITLES_LIMIT);
  const artistIds = distinct(plays.rows, "artist_id").slice(0, EXPORT_TITLES_LIMIT);
  const trackTitles = new Map((await fetchByIds(db, "tracks", "id, title", "id", trackIds)).rows.map((r) => [String(r.id), String(r.title)] as const));
  const artistNames = new Map((await fetchByIds(db, "artists", "id, name", "id", artistIds)).rows.map((r) => [String(r.id), String(r.name)] as const));
  sections.plays = { ...plays, rows: attachNames(plays.rows, trackTitles, artistNames) };

  // Ce que le compte publie, s'il est créateur.
  sections.artists = await fetchRows(db, {
    table: "artists",
    columns: "id, catalog_code, name, slug, bio, country, verified, created_at",
    where: mine("user_id"),
  });
  const myArtistIds = distinct(sections.artists.rows, "id");
  sections.tracks = await fetchByIds(
    db, "tracks", "id, catalog_code, title, status, explicit, duration_seconds, created_at, published_at", "artist_id", myArtistIds
  );
  sections.albums = await fetchByIds(db, "albums", "id, catalog_code, title, type, status, release_date", "artist_id", myArtistIds);

  return sections;
}

const NOTES = [
  "This file lists the personal data Vynl holds on your account, in JSON.",
  "Not included: internal security data (fraud signals, administration logs, hashed IP addresses, content checks), which we keep to protect the service and the artists.",
  "Payment card details and identity verification are held by our payment provider, Stripe, not by Vynl: ask Stripe for them.",
  "Listening history is limited to the most recent entries when it is very long; `meta.truncated` says so.",
];

const SINGLE = new Set(["account", "profile", "creator_onboarding"]);

export function buildExport(input: { userId: string; generatedAt: Date; sections: Record<string, ExportSection> }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format_version: EXPORT_FORMAT_VERSION,
    generated_at: input.generatedAt.toISOString(),
    account_id: input.userId,
    notes: NOTES,
  };
  const truncated: string[] = [];
  const unavailable: string[] = [];
  for (const [name, section] of Object.entries(input.sections)) {
    out[name] = SINGLE.has(name) ? (section.rows[0] ?? null) : section.rows;
    if (section.truncated) truncated.push(name);
    if (section.unavailable) unavailable.push(name);
  }
  out.meta = { truncated, unavailable };
  return out;
}

export async function exportAccount(userId: string, now: Date = new Date(), db: ExportDb = defaultDb()): Promise<Record<string, unknown>> {
  return buildExport({ userId, generatedAt: now, sections: await collectSections(userId, db) });
}
