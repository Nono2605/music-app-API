import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";

export const tracksRouter = Router();

const AUDIO_BUCKET = "track-audio";

// GET /tracks — catalogue public, paginé, morceaux publiés uniquement.
// ?q= filtre par titre (recherche partielle, insensible à la casse).
tracksRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let query = supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, artists(name), albums(cover_url)")
      .eq("status", "published");

    if (q) query = query.ilike("title", `%${q}%`);

    const { data, error } = await query
      .order("published_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id — métadonnées publiques d'un morceau publié.
// Ne renvoie jamais de storage_key/URL brute ici : la lecture audio passe
// par un flux d'autorisation dédié (voir DATA_FLOW.md, §3 Lecture/streaming).
tracksRouter.get("/:id", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, explicit, status, artist_id, album_id")
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Track not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id/stream — URL signée (courte durée) vers le fichier audio.
// Auth requise mais pas de vérification de rôle : tout compte connecté peut
// écouter un morceau publié (les règles d'abonnement viendront se greffer
// ici plus tard sans changer la forme de la réponse).
tracksRouter.get("/:id/stream", requireAuth, async (req, res, next) => {
  try {
    const { data: track, error: trackError } = await supabaseAdmin
      .from("tracks")
      .select("id")
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();
    if (trackError) throw trackError;
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { data: file, error: fileError } = await supabaseAdmin
      .from("track_files")
      .select("storage_key, format")
      .eq("track_id", track.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (fileError) throw fileError;
    if (!file) return res.status(404).json({ error: "No audio file for this track" });

    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(file.storage_key, 60 * 60 * 6);
    if (signError) throw signError;

    res.json({ url: signed.signedUrl, format: file.format });
  } catch (err) {
    next(err);
  }
});
