import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { clock } from "../../lib/clock";
import { env } from "../../config/env";
import { parseClientInfo } from "../../lib/clientInfo";
import { clientHeadersFor } from "../../lib/webappAuth";
import { loadEntitlement } from "../../lib/loadEntitlement";
import { allowsExplicit } from "../../lib/explicit";
import { signedStreamUrl } from "../../lib/streamUrl";
import { DEFAULT_QUALITY, isStreamQuality } from "../../lib/renditions";
import { applyHeartbeat, HEARTBEAT_EVERY_SECONDS, type HeartbeatState } from "./heartbeat";

export const playsRouter = Router();

// Spec : docs/SPEC_REMUNERATION.md, sections 5 et 6. Une lecture démarre ici
// (POST /plays) et se mesure par battements (POST /plays/:id/heartbeat) ; les
// secondes écoutées sont calculées par le serveur (heartbeat.ts), jamais
// déclarées par le client.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_CONTEXTS = new Set(["album", "playlist", "artist", "discover", "search", "library", "track"]);
const HEARTBEAT_STATES = new Set<HeartbeatState>(["playing", "paused", "ended", "closed"]);

// Ferme les lectures encore ouvertes du compte : un seul flux à la fois. La fin
// retenue est le dernier battement reçu, pas « maintenant » : on ne s'attribue
// pas du temps qu'on n'a pas vu.
async function closeOpenPlays(userId: string) {
  const { data: open, error } = await supabaseAdmin
    .from("plays")
    .select("id, last_heartbeat_at")
    .eq("user_id", userId)
    .is("ended_at", null);
  if (error) throw error;

  for (const play of open ?? []) {
    const { error: closeError } = await supabaseAdmin
      .from("plays")
      .update({ ended_at: play.last_heartbeat_at, last_state: "closed" })
      .eq("id", play.id)
      .is("ended_at", null);
    if (closeError) throw closeError;
  }
}

// POST /plays — démarre une lecture. Remplace GET /tracks/:id/stream pour
// écouter : sans passer par ici, une écoute ne serait pas comptée.
//   body : { track_id, client_session_id?, source_context?, source_id?, app_version?, quality? }
//   quality : « standard » (128 kbit/s, par défaut) ou « high » (256 kbit/s), pour les morceaux servis par le CDN.
playsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.id;
    const { track_id, client_session_id, source_context, source_id, app_version, quality } = req.body ?? {};

    if (typeof track_id !== "string" || !UUID.test(track_id)) {
      return res.status(400).json({ error: "track_id must be a UUID" });
    }
    if (client_session_id !== undefined && (typeof client_session_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(client_session_id))) {
      return res.status(400).json({ error: "client_session_id must be 1 to 64 letters, digits, _ or -" });
    }
    if (source_context !== undefined && (typeof source_context !== "string" || !SOURCE_CONTEXTS.has(source_context))) {
      return res.status(400).json({ error: "Invalid source_context" });
    }
    if (source_id !== undefined && (typeof source_id !== "string" || !UUID.test(source_id))) {
      return res.status(400).json({ error: "source_id must be a UUID" });
    }
    if (app_version !== undefined && (typeof app_version !== "string" || app_version.length > 32)) {
      return res.status(400).json({ error: "app_version must be at most 32 characters" });
    }
    if (quality !== undefined && !isStreamQuality(quality)) {
      return res.status(400).json({ error: "quality must be standard or high" });
    }

    const { data: track, error: trackError } = await supabaseAdmin
      .from("tracks")
      .select("id, artist_id, album_id, duration_seconds, explicit")
      .eq("id", track_id)
      .eq("status", "published")
      .maybeSingle();
    if (trackError) throw trackError;
    if (!track) return res.status(404).json({ error: "Track not found" });

    // Contenu explicite refusé dans les réglages de l'auditeur : on ne délivre rien, quelle que soit
    // la liste d'où vient le morceau (playlist, favoris, lien). Le lecteur passe au suivant.
    if (track.explicit === true) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("explicit_content")
        .eq("user_id", userId)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!allowsExplicit(profile)) {
        return res.status(403).json({ error: "Explicit content is turned off in your settings", code: "explicit_blocked" });
      }
    }

    // Avant de créer quoi que ce soit : un morceau sans fichier ne s'écoute pas.
    const stream = await signedStreamUrl(track.id, quality ?? DEFAULT_QUALITY);
    if (!stream) return res.status(404).json({ error: "No audio file for this track" });

    const respond = (status: number, playId: string) =>
      res.status(status).json({
        play_id: playId,
        url: stream.url,
        format: stream.format,
        heartbeat_every_seconds: HEARTBEAT_EVERY_SECONDS,
      });

    // Rejeu de la même requête (réseau instable, ou deux requêtes jumelles) : on
    // rend la même lecture au lieu d'en créer une seconde.
    const replayIfKnown = async () => {
      if (client_session_id === undefined) return null;
      const { data: known, error } = await supabaseAdmin
        .from("plays")
        .select("id, ended_at")
        .eq("user_id", userId)
        .eq("client_session_id", client_session_id)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!known) return null;
      return known.ended_at === null
        ? respond(200, known.id)
        : res.status(409).json({ error: "This play is already closed" });
    };
    const replayed = await replayIfKnown();
    if (replayed) return replayed;

    const now = clock.now();
    const entitlement = await loadEntitlement(userId, now);
    // Pays, appareil, empreinte d'IP : transmis par la webapp (lib/clientInfo.ts). Si un secret partagé est défini
    // (lib/webappAuth.ts), on ne les croit que d'une requête qui le présente.
    const client = parseClientInfo(clientHeadersFor(req.headers, env.webappSharedSecret), { ipHashSecret: env.ipHashSecret, now });

    const insert = () =>
      supabaseAdmin
        .from("plays")
        .insert({
          user_id: userId,
          track_id: track.id,
          // Copiés : renommer ou corriger le morceau ne réécrit pas l'histoire.
          artist_id: track.artist_id,
          album_id: track.album_id,
          track_duration_seconds: track.duration_seconds,
          entitlement,
          source_context: source_context ?? null,
          source_id: source_id ?? null,
          client_session_id: client_session_id ?? null,
          app_version: app_version ?? null,
          country_code: client.country_code,
          device_type: client.device_type,
          ip_hash: client.ip_hash,
          started_at: now.toISOString(),
          last_heartbeat_at: now.toISOString(),
        })
        .select("id")
        .single();

    // Un seul flux ouvert par compte : on ferme l'éventuel précédent d'abord. Si
    // deux démarrages arrivent en même temps, l'index unique de la base refuse le
    // second. Avant de fermer quoi que ce soit, on regarde si c'est une requête
    // jumelle (même client_session_id) qui a gagné : on rend alors SA lecture, sans
    // la fermer. Sinon c'est un autre morceau : on referme et on réessaie.
    await closeOpenPlays(userId);
    let { data: play, error } = await insert();
    if (error?.code === "23505") {
      const twin = await replayIfKnown();
      if (twin) return twin;
      await closeOpenPlays(userId);
      ({ data: play, error } = await insert());
      if (error?.code === "23505") {
        const lateTwin = await replayIfKnown();
        if (lateTwin) return lateTwin;
      }
    }
    if (error) throw error;

    respond(201, play!.id);
  } catch (err) {
    next(err);
  }
});

// POST /plays/:id/heartbeat — { seq, position_seconds, state }.
// Réponses 200 même quand rien n'est crédité (rejeu, lecture déjà close) : le
// client doit pouvoir réessayer sans que ce soit une erreur. `status` dit ce qui
// s'est passé : ok | duplicate | closed | conflict.
playsRouter.post("/:id/heartbeat", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.id;
    const { seq, position_seconds, state } = req.body ?? {};

    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid play id" });
    if (!Number.isInteger(seq) || seq < 1 || seq > 1_000_000) {
      return res.status(400).json({ error: "seq must be an integer from 1 to 1000000" });
    }
    if (typeof position_seconds !== "number" || !Number.isFinite(position_seconds) || position_seconds < 0 || position_seconds > 100_000) {
      return res.status(400).json({ error: "position_seconds must be a number from 0 to 100000" });
    }
    if (typeof state !== "string" || !HEARTBEAT_STATES.has(state as HeartbeatState)) {
      return res.status(400).json({ error: "state must be one of playing, paused, ended, closed" });
    }

    const { data: play, error } = await supabaseAdmin
      .from("plays")
      .select(
        "id, last_heartbeat_at, last_position_seconds, last_state, last_seq, validated_seconds, track_duration_seconds, qualified, ended_at"
      )
      .eq("id", req.params.id)
      .eq("user_id", userId) // on ne mesure que ses propres lectures
      .maybeSingle();
    if (error) throw error;
    if (!play) return res.status(404).json({ error: "Play not found" });

    const summary = (p: { validated_seconds: number; qualified: boolean }) => ({
      validated_seconds: Number(p.validated_seconds),
      qualified: p.qualified,
    });

    const now = clock.now();
    const outcome = applyHeartbeat(
      {
        ...play,
        // numeric(10,3) : renvoyé tel quel par PostgREST, on garantit des nombres.
        last_position_seconds: Number(play.last_position_seconds),
        validated_seconds: Number(play.validated_seconds),
      },
      { seq, position_seconds, state: state as HeartbeatState },
      now
    );

    if (outcome.kind === "closed") return res.json({ status: "closed", ...summary(play) });
    if (outcome.kind === "duplicate") return res.json({ status: "duplicate", ...summary(play) });

    // Mise à jour conditionnelle : si un autre battement est passé entre-temps
    // (last_seq a changé), on n'écrase pas. Le battement suivant, calculé d'après
    // la position, rattrape l'intervalle : rien n'est perdu pour de bon.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("plays")
      .update(outcome.update)
      .eq("id", play.id)
      .eq("last_seq", play.last_seq)
      .is("ended_at", null)
      .select("validated_seconds, qualified");
    if (updateError) throw updateError;
    if (!updated || updated.length === 0) return res.json({ status: "conflict", ...summary(play) });

    // Trace brute, à titre de preuve : un échec ici ne doit pas faire perdre la mesure.
    const { error: traceError } = await supabaseAdmin.from("play_heartbeats").insert({
      play_id: play.id,
      seq,
      state,
      position_seconds,
      credited_seconds: outcome.credited_seconds,
      received_at: now.toISOString(),
    });
    if (traceError) console.error("play_heartbeats insert failed", traceError);

    res.json({ status: "ok", ended: outcome.update.ended_at !== undefined, ...summary(updated[0]) });
  } catch (err) {
    next(err);
  }
});
