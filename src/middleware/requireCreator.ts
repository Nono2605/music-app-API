import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin";

// Doit être monté après requireAuth. Charge le rôle depuis public.users
// (jamais depuis le JWT) et bloque tout ce qui n'est pas creator/admin.
export async function requireCreator(req: Request, res: Response, next: NextFunction) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", req.auth!.id)
    .single();

  if (error || !data) return res.status(403).json({ error: "Forbidden" });
  if (data.role !== "creator" && data.role !== "admin") {
    return res.status(403).json({ error: "Creator role required" });
  }
  next();
}
