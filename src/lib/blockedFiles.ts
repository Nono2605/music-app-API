// La liste de blocage (table blocked_files, migration 20261025000002) : les empreintes SHA-256 des fichiers de morceaux
// retirés à la suite d'un signalement d'ayant droit. Un fichier de cette liste ne peut pas être renvoyé, par personne.
//
// Le message ne dit JAMAIS pourquoi ni à la suite de quel signalement. Si la table n'existe pas encore (migration pas
// appliquée), rien n'est bloqué. Toute AUTRE panne de lecture lève l'erreur : refuser l'envoi (500, l'artiste réessaie)
// vaut mieux que laisser passer un fichier qui devrait être bloqué.
import { isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

export const BLOCKED_FILE_MESSAGE = "This file cannot be accepted. If you think this is a mistake, please contact support.";

interface BlockedQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  limit(count: number): BlockedQuery;
}
export interface BlockedDb {
  from(table: string): { select(columns: string): { eq(column: string, value: unknown): BlockedQuery } };
}

export async function isBlockedChecksum(checksum: string, db: BlockedDb = supabaseAdmin as unknown as BlockedDb): Promise<boolean> {
  // Une empreinte SHA-256 en hexadécimal minuscule, ou rien à comparer.
  if (!/^[0-9a-f]{64}$/.test(checksum)) return false;
  const { data, error } = await db.from("blocked_files").select("id").eq("checksum", checksum).limit(1);
  if (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
  return (data?.length ?? 0) > 0;
}
