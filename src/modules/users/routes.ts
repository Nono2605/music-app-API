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
      .select("username, display_name, avatar_url, bio, country, locale, explicit_content, favorite_genres")
      .eq("user_id", req.auth!.id)
      .maybeSingle();

    if (profileError) throw profileError;

    res.json({ ...user, profile: profile ?? null });
  } catch (err) {
    next(err);
  }
});

// POST /profile — crée ou met à jour le profil (identité publique et/ou
// préférences d'écoute). username toujours requis (identifiant stable pour
// l'upsert) ; les autres champs ne sont touchés que s'ils sont présents dans
// le body, pour qu'un appel qui ne met à jour que les préférences n'efface
// pas display_name/bio en les repassant à null. username est unique en
// base : une violation de contrainte devient un 409.
usersRouter.post("/profile", requireAuth, async (req, res, next) => {
  try {
    const {
      username,
      display_name: displayName,
      bio,
      explicit_content: explicitContent,
      favorite_genres: favoriteGenres,
    } = req.body ?? {};
    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({ error: "username must be at least 3 characters" });
    }

    const payload: Record<string, unknown> = {
      user_id: req.auth!.id,
      username: username.trim(),
    };
    if (displayName !== undefined) payload.display_name = displayName || null;
    if (bio !== undefined) payload.bio = bio || null;
    if (typeof explicitContent === "boolean") payload.explicit_content = explicitContent;
    if (Array.isArray(favoriteGenres)) {
      payload.favorite_genres = favoriteGenres.filter((g) => typeof g === "string" && g.trim());
    }

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .upsert(payload, { onConflict: "user_id" })
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

// GET /users/:username — profil public. Playlists : toutes si on consulte
// son propre profil (avec leur statut public/privé), sinon uniquement les
// publiques. followers_count = qui me suit ; following_count = les autres
// utilisateurs que je suis (les artistes suivis ne comptent pas ici, c'est
// un concept séparé, cf. /artists/:id/follow).
usersRouter.get("/users/:username", requireAuth, async (req, res, next) => {
  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, username, display_name, avatar_url, bio, created_at")
      .eq("username", req.params.username)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return res.status(404).json({ error: "User not found" });

    const isOwner = profile.user_id === req.auth!.id;

    const [followersRes, followingRes, followingRow] = await Promise.all([
      supabaseAdmin
        .from("follows")
        .select("id", { count: "exact", head: true })
        .eq("followed_user_id", profile.user_id),
      supabaseAdmin
        .from("follows")
        .select("id", { count: "exact", head: true })
        .eq("follower_id", profile.user_id)
        .not("followed_user_id", "is", null),
      isOwner
        ? Promise.resolve(null)
        : supabaseAdmin
            .from("follows")
            .select("id")
            .eq("follower_id", req.auth!.id)
            .eq("followed_user_id", profile.user_id)
            .maybeSingle(),
    ]);
    if (followersRes.error) throw followersRes.error;
    if (followingRes.error) throw followingRes.error;
    if (followingRow?.error) throw followingRow.error;

    let playlistsQuery = supabaseAdmin
      .from("playlists")
      .select("id, title, cover_url, is_public")
      .eq("owner_id", profile.user_id)
      .order("created_at", { ascending: false });
    if (!isOwner) playlistsQuery = playlistsQuery.eq("is_public", true);
    const { data: playlists, error: playlistsError } = await playlistsQuery;
    if (playlistsError) throw playlistsError;

    res.json({
      id: profile.user_id,
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      created_at: profile.created_at,
      is_owner: isOwner,
      is_following: !!followingRow?.data,
      followers_count: followersRes.count ?? 0,
      following_count: followingRes.count ?? 0,
      playlists,
    });
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/follow — suivre un autre utilisateur (pas un artiste).
usersRouter.post("/users/:id/follow", requireAuth, async (req, res, next) => {
  try {
    if (req.params.id === req.auth!.id) {
      return res.status(400).json({ error: "You cannot follow yourself" });
    }

    const { error } = await supabaseAdmin
      .from("follows")
      .insert({ follower_id: req.auth!.id, followed_user_id: req.params.id });

    if (error && error.code !== "23505") throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /users/:id/follow
usersRouter.delete("/users/:id/follow", requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("follows")
      .delete()
      .eq("follower_id", req.auth!.id)
      .eq("followed_user_id", req.params.id);

    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
