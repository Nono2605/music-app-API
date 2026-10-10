import { createStatusCache } from "./accountStatus";
import { supabaseAdmin } from "./supabaseAdmin";

// Une minute : assez court pour qu'une suspension décidée dans l'admin prenne
// effet vite, assez long pour ne pas lire la base à chaque battement de cœur.
const STATUS_TTL_MS = 60_000;

export const loadAccountStatus = createStatusCache(async (userId) => {
  const { data, error } = await supabaseAdmin.from("users").select("status").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}, STATUS_TTL_MS);
