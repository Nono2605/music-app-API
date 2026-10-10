import { env } from "../config/env";
import { resolveEntitlement, type Entitlement } from "./entitlement";
import { supabaseAdmin } from "./supabaseAdmin";

export async function loadEntitlement(userId: string, now: Date): Promise<Entitlement> {
  if (env.entitlementMode === "beta") return "beta"; // pas besoin d'interroger la base
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return resolveEntitlement("live", data, now);
}
