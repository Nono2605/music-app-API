import { isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

// Registre des demandes de droits (export, suppression), pour pouvoir montrer qu'elles sont traitées
// (table privacy_requests). Écriture « au mieux » : un registre en panne ne doit pas empêcher quelqu'un
// d'exercer ses droits. Aucune donnée personnelle dans `detail`. Pour une suppression, user_id reste vide :
// le compte n'existe plus.

export interface PrivacyRequestRecord {
  kind: "export" | "deletion";
  status: "completed" | "failed";
  user_id?: string | null;
  detail?: Record<string, unknown>;
}

export interface PrivacyRequestDb {
  from(table: string): { insert(row: unknown): PromiseLike<{ error: unknown }> };
}

export async function recordPrivacyRequest(
  record: PrivacyRequestRecord,
  db: PrivacyRequestDb = supabaseAdmin as unknown as PrivacyRequestDb
): Promise<void> {
  try {
    const { error } = await db.from("privacy_requests").insert({ ...record, completed_at: new Date().toISOString() });
    if (error && !isMissingTable(error)) {
      console.error("Could not record a privacy request:", (error as { message?: string }).message ?? error);
    }
  } catch (err) {
    console.error("Could not record a privacy request:", (err as { message?: string })?.message ?? err);
  }
}
