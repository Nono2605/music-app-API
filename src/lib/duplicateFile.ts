// Le MÊME fichier audio (empreinte SHA-256, identique octet pour octet) déjà envoyé par UN AUTRE artiste :
// copie probable. Un même artiste peut réutiliser son fichier (un single puis l'album) ; un autre non.
// Ne détecte que les copies exactes : un fichier ré-encodé ou coupé demande une empreinte acoustique
// (spec 15.5, D2 et D3).
//
// Le message ne dit JAMAIS chez qui se trouve le fichier. Si la vérification elle-même échoue, on laisse
// passer (et on le journalise) : un contrôle en panne ne doit pas empêcher un artiste de travailler.

import { supabaseAdmin } from "./supabaseAdmin";

export const DUPLICATE_FILE_MESSAGE =
  "This exact audio file is already on Vynl. If you own it, please contact support.";

// Juste ce qu'il faut du client Supabase, pour pouvoir le remplacer dans les tests.
interface Query<T> extends PromiseLike<{ data: T[] | null; error: unknown }> {
  eq(column: string, value: unknown): Query<T>;
  neq(column: string, value: unknown): Query<T>;
  in(column: string, values: unknown[]): Query<T>;
  is(column: string, value: null): Query<T>;
  limit(count: number): Query<T>;
}
export interface DuplicateDb {
  from(table: string): { select(columns: string): Query<Record<string, unknown>> };
}

export interface ForeignDuplicate {
  trackId: string;
  trackFileId: string;
  artistId: string;
}

// L'artiste d'un morceau a été supprimé (compte effacé, page anonymisée « Deleted artist ») : il n'existe plus. Son fichier
// n'est pas une copie qu'on pourrait écouter sur Vynl, et celui qui a supprimé son compte doit pouvoir renvoyer SA musique
// depuis un nouveau compte. (Les fichiers retirés après un signalement d'ayant droit restent bloqués par la liste de blocage,
// lib/blockedFiles.ts, qui ne dépend pas de l'artiste.)
function artistIsGone(relation: unknown): boolean {
  const artist = (Array.isArray(relation) ? relation[0] : relation) as { anonymized_at?: unknown } | null | undefined;
  return Boolean(artist?.anonymized_at);
}

// Les fichiers de même empreinte qui existent ENCORE (un fichier purgé du stockage ne compte pas), puis ceux qui appartiennent
// à un morceau d'un AUTRE artiste encore actif. Deux requêtes simples plutôt qu'une jointure : plus sûres, et le volume est
// minuscule. LÈVE l'erreur si la base répond mal : à l'appelant de décider (l'envoi laisse passer, le contrôle automatique
// signale « indisponible »).
export async function lookupForeignDuplicate(checksum: string, artistId: string, db: DuplicateDb = supabaseAdmin as unknown as DuplicateDb): Promise<ForeignDuplicate | null> {
  const files = await db.from("track_files").select("id, track_id").eq("checksum", checksum).is("purged_at", null).limit(50);
  if (files.error) throw files.error;
  const rows = (files.data ?? []) as { id: string; track_id: string }[];
  if (rows.length === 0) return null;

  const trackIds = [...new Set(rows.map((row) => row.track_id))];
  const tracks = await db.from("tracks").select("id, artist_id, artists(anonymized_at)").in("id", trackIds).neq("artist_id", artistId).limit(50);
  if (tracks.error) throw tracks.error;
  const other = ((tracks.data ?? []) as { id: string; artist_id: string; artists?: unknown }[]).find((row) => !artistIsGone(row.artists));
  if (!other) return null;

  const file = rows.find((row) => row.track_id === other.id);
  return { trackId: other.id, trackFileId: file?.id ?? "", artistId: other.artist_id };
}

export async function findForeignDuplicate(checksum: string, artistId: string, db: DuplicateDb = supabaseAdmin as unknown as DuplicateDb): Promise<ForeignDuplicate | null> {
  try {
    return await lookupForeignDuplicate(checksum, artistId, db);
  } catch (err) {
    console.error("Duplicate file check failed (upload allowed):", (err as { message?: string })?.message ?? err);
    return null;
  }
}
