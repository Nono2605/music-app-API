import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const usersRouter = Router();

// GET /me — profil de l'utilisateur authentifié (users + profiles).
usersRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("id, email, role, status, created_at")
      .eq("id", req.auth!.id)
      .single();

    if (userError) throw userError;

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("username, display_name, avatar_url, bio, country, locale")
      .eq("user_id", req.auth!.id)
      .maybeSingle();

    if (profileError) throw profileError;

    res.json({ ...user, profile: profile ?? null });
  } catch (err) {
    next(err);
  }
});

// POST /profile — crée ou met à jour le profil public (onboarding).
// username est unique en base : une violation de contrainte devient un 409.
usersRouter.post("/profile", requireAuth, async (req, res, next) => {
  try {
    const { username, display_name: displayName, bio } = req.body ?? {};
    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({ error: "username must be at least 3 characters" });
    }

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          user_id: req.auth!.id,
          username: username.trim(),
          display_name: displayName ?? null,
          bio: bio ?? null,
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "username already taken" });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// GET /me/follows/:artistId — l'utilisateur connecté suit-il déjà cet artiste ?
usersRouter.get("/me/follows/:artistId", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("follows")
      .select("id")
      .eq("follower_id", req.auth!.id)
      .eq("artist_id", req.params.artistId)
      .maybeSingle();

    if (error) throw error;
    res.json({ following: !!data });
  } catch (err) {
    next(err);
  }
});
