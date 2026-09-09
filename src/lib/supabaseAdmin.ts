import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { env } from "../config/env";

// Client privilégié (service role) — usage serveur uniquement.
// Bypass RLS : jamais exposé à un client, jamais importé côté front.
// `realtime.transport` est requis explicitement : Node < 22 n'a pas de
// WebSocket natif, et supabase-js en a besoin même si le realtime n'est
// pas utilisé (l'API n'a que du REST pour l'instant).
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: WebSocket as any,
  },
});
