import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { clock } from "../../lib/clock";
import { myArtistId } from "../../lib/myArtistId";
import { isoDay, parseStatsRange, RANGE_KEYS } from "./statsRange";
import {
  shapeBreakdown,
  shapeDaily,
  shapeTopTracks,
  shapeTotals,
  type Breakdown,
  type DailyPoint,
  type TopTrack,
  type Totals,
} from "./statsShape";

// Monté dans creator/routes.ts, donc APRÈS requireAuth et requireCreator : seul
// un créateur connecté arrive ici, et on ne lit jamais que SON artiste.

export const creatorStatsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Codes d'erreur quand la migration 20261010000000_creator_stats.sql (ou celle de
// `plays`) n'est pas encore appliquée : fonction introuvable (PostgREST / Postgres)
// ou table absente. Ce n'est pas une panne : le client affiche « pas encore
// disponible » au lieu d'une erreur.
const NOT_MIGRATED_CODES = new Set(["PGRST202", "42883", "PGRST205", "42P01"]);

async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

export interface StatsResponse {
  range: { key: string; days: number; from: string; to: string };
  track_id: string | null;
  totals: Omit<Totals, "new_followers"> & { new_followers: number | null };
  previous: Omit<Totals, "new_followers"> & { new_followers: number | null };
  daily: DailyPoint[];
  breakdown: Breakdown;
  /** Absent quand la vue est celle d'un seul morceau. */
  top_tracks: TopTrack[] | null;
}

// GET /creator/stats?range=7d|30d|90d[&track_id=<uuid>]
//
// Une écoute = une lecture comptée ET qualifiée (30 s validées) ; les définitions
// complètes sont dans la migration SQL. Un seul aller-retour pour tout l'écran :
// totaux de la fenêtre et de la précédente (pour les variations), série
// journalière, répartition (source / pays / appareil) et, hors vue d'un morceau,
// le classement des morceaux.
creatorStatsRouter.get("/", async (req, res, next) => {
  try {
    const range = parseStatsRange(req.query.range, clock.now());
    if (!range) {
      return res.status(400).json({ error: `range must be one of ${RANGE_KEYS.join(", ")}` });
    }

    let trackId: string | null = null;
    if (req.query.track_id !== undefined) {
      if (typeof req.query.track_id !== "string" || !UUID.test(req.query.track_id)) {
        return res.status(400).json({ error: "track_id must be a UUID" });
      }
      trackId = req.query.track_id;
    }

    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.status(404).json({ error: "Artist profile not found" });

    // Les fonctions SQL font confiance à l'artiste qu'on leur donne : le morceau
    // demandé doit donc être l'un des siens, sinon on répondrait pour le morceau
    // d'un autre artiste.
    if (trackId) {
      const { data: track, error } = await supabaseAdmin
        .from("tracks")
        .select("id")
        .eq("id", trackId)
        .eq("artist_id", artistId)
        .maybeSingle();
      if (error) throw error;
      if (!track) return res.status(404).json({ error: "Track not found" });
    }

    const window = (from: Date, to: Date) => ({
      p_artist_id: artistId,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_track_id: trackId,
    });

    const [totals, previous, daily, breakdown, topTracks] = await Promise.all([
      rpc("creator_stats_totals", window(range.from, range.to)),
      rpc("creator_stats_totals", window(range.previousFrom, range.previousTo)),
      rpc("creator_stats_daily", window(range.from, range.to)),
      rpc("creator_stats_breakdown", window(range.from, range.to)),
      trackId
        ? Promise.resolve(null)
        : rpc("creator_stats_top_tracks", {
            p_artist_id: artistId,
            p_from: range.from.toISOString(),
            p_to: range.to.toISOString(),
            p_limit: 10,
          }),
    ]);

    // Les followers sont ceux de l'artiste, pas d'un morceau : sur la vue d'un
    // morceau on ne les affiche pas plutôt que d'en donner un chiffre trompeur.
    const forView = (row: Record<string, unknown> | undefined) => {
      const shaped = shapeTotals(row);
      return { ...shaped, new_followers: trackId ? null : shaped.new_followers };
    };

    const body: StatsResponse = {
      range: {
        key: range.key,
        days: range.days,
        from: isoDay(range.from),
        to: isoDay(new Date(range.to.getTime() - 1)), // dernier jour inclus
      },
      track_id: trackId,
      totals: forView(totals[0]),
      previous: forView(previous[0]),
      daily: shapeDaily(daily),
      breakdown: shapeBreakdown(breakdown),
      top_tracks: topTracks ? shapeTopTracks(topTracks) : null,
    };
    res.json(body);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && NOT_MIGRATED_CODES.has(code)) {
      return res.status(503).json({ error: "Listening stats are not available yet", code: "stats_unavailable" });
    }
    next(err);
  }
});
