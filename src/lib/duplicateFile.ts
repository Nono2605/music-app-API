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
  limit(count: number): Query<T>;
}
export interface DuplicateDb {
  from(table: string): { select(columns: string): Query<Record<string, string>> };
}

export interface ForeignDuplicate {
  trackId: string;
  trackFileId: string;
}

// Les fichiers de même empreinte, puis ceux qui appartiennent à un morceau d'un AUTRE artiste. Deux
// requêtes simples plutôt qu'une jointure : plus sûres, et le volume est minuscule.
export async function findForeignDuplicate(
  checksum: string,
  artistId: string,
  db: DuplicateDb = supabaseAdmin as unknown as DuplicateDb
): Promise<ForeignDuplicate | null> {
  try {
    const files = await db.from("track_files").select("id, track_id").eq("checksum", checksum).limit(50);
    if (files.error) throw files.error;
    const rows = files.data ?? [];
    if (rows.length === 0) return null;

    const trackIds = [...new Set(rows.map((row) => row.track_id))];
    const tracks = await db.from("tracks").select("id").in("id", trackIds).neq("artist_id", artistId).limit(1);
    if (tracks.error) throw tracks.error;
    const other = tracks.data?.[0];
    if (!other) return null;

    const file = rows.find((row) => row.track_id === other.id);
    return { trackId: other.id, trackFileId: file?.id ?? "" };
  } catch (err) {
    console.error("Duplicate file check failed (upload allowed):", (err as { message?: string })?.message ?? err);
    return null;
  }
}
