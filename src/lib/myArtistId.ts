import { supabaseAdmin } from "./supabaseAdmin";

// Résout l'artiste du créateur connecté. Un créateur possède au plus une
// page artiste dans cette version (pas de multi-artiste par compte).
export async function myArtistId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("artists")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
