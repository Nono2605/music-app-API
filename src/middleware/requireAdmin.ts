import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin";

// Doit être monté après requireAuth. Charge le rôle depuis public.users (jamais depuis le
// JWT, comme requireCreator) et ne laisse passer qu'un admin ACTIF.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("role, status")
      .eq("id", req.auth!.id)
      .maybeSingle();

    if (error) throw error;
    if (!data || data.role !== "admin" || data.status !== "active") {
      return res.status(403).json({ error: "Admin role required" });
    }
    next();
  } catch (err) {
    next(err);
  }
}
