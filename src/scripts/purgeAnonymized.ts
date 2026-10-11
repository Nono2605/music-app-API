// Purge des FICHIERS des artistes anonymisés (compte supprimé) une fois leur délai de
// grâce écoulé (30 jours, `artists.purge_after`). À lancer régulièrement, à la main
// ou depuis une tâche planifiée.
//
//   npm run purge:anonymized                          simulation : liste, ne supprime RIEN
//   npm run purge:anonymized -- --apply               supprime les fichiers échus
//   npm run purge:anonymized -- --sweep-orphans       liste les artistes sans compte non anonymisés
//   npm run purge:anonymized -- --sweep-orphans --apply   les anonymise (puis purge à 30 jours)
//
// Ce que fait la purge, pour chaque artiste anonymisé, échu, non purgé et SANS gel légal
// (`legal_hold`) :
//   - supprime du stockage ses fichiers audio (bucket track-audio) et ses images
//     (bucket artist-images) ;
//   - marque `track_files.purged_at` et `artists.purged_at`.
// Ce qu'elle NE fait JAMAIS : supprimer une ligne en base. Numéros, titres, durées,
// ISRC, empreintes SHA-256, écoutes, royalties et déclarations restent (pièces
// comptables, 10 ans ; preuves en cas de litige).
//
// --sweep-orphans : filet de sécurité pour les artistes dont le compte a disparu sans
// que l'anonymisation automatique ait abouti. ATTENTION : il vise TOUT artiste sans
// compte ; un artiste créé à la main par l'administration, sans compte, serait aussi
// visé. Lisez toujours la simulation avant --apply.
//
// Utilise la clé secrète de .env : il agit sur la base et le stockage RÉELS.
// Prérequis : migration 20261011000000_catalog_numbers_and_artist_names.sql.

import { parseArgs } from "node:util";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { chunk, isPurgeDue } from "../lib/purge";

const AUDIO_BUCKET = "track-audio";
const IMAGE_BUCKET = "artist-images";
const REMOVE_BATCH = 100;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "sweep-orphans": { type: "boolean", default: false },
  },
});
const apply = values.apply === true;

async function removeFromBucket(bucket: string, paths: string[]): Promise<void> {
  for (const batch of chunk(paths, REMOVE_BATCH)) {
    const { error } = await supabaseAdmin.storage.from(bucket).remove(batch);
    if (error) throw error;
  }
}

async function sweepOrphans(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("artists")
    .select("id, name, catalog_code, created_at")
    .is("user_id", null)
    .is("anonymized_at", null);
  if (error) throw error;

  console.log(`\n== Artistes sans compte, non anonymisés : ${data.length} ==`);
  for (const a of data) {
    console.log(`- ${a.catalog_code}  « ${a.name} »  créé le ${String(a.created_at).slice(0, 10)}`);
  }
  if (!apply || data.length === 0) {
    if (data.length > 0) console.log("(simulation : rien n'est modifié ; --apply pour les anonymiser)");
    return;
  }
  for (const a of data) {
    const { error: rpcError } = await supabaseAdmin.rpc("anonymize_artist", {
      p_artist_id: a.id,
      p_reason: "orphan_sweep",
    });
    console.log(rpcError ? `ÉCHEC  ${a.catalog_code}: ${rpcError.message}` : `anonymisé  ${a.catalog_code}`);
  }
}

async function purgeDue(): Promise<void> {
  const { data: artists, error } = await supabaseAdmin
    .from("artists")
    .select("id, name, catalog_code, anonymized_at, purge_after, purged_at, legal_hold")
    .not("anonymized_at", "is", null)
    .is("purged_at", null);
  if (error) throw error;

  const now = new Date();
  const due = artists.filter((a) => isPurgeDue(a, now));
  const waiting = artists.length - due.length;
  console.log(`\n== Artistes anonymisés à purger : ${due.length} échus (${waiting} en attente ou sous gel légal) ==`);

  for (const artist of due) {
    const { data: tracks, error: tracksError } = await supabaseAdmin
      .from("tracks")
      .select("id")
      .eq("artist_id", artist.id);
    if (tracksError) throw tracksError;
    const trackIds = tracks.map((t) => t.id);

    const files =
      trackIds.length === 0
        ? []
        : await (async () => {
            const { data, error: filesError } = await supabaseAdmin
              .from("track_files")
              .select("id, storage_key")
              .in("track_id", trackIds)
              .is("purged_at", null);
            if (filesError) throw filesError;
            return data;
          })();

    const { data: images, error: imagesError } = await supabaseAdmin.storage.from(IMAGE_BUCKET).list(artist.id);
    if (imagesError) throw imagesError;
    const imagePaths = (images ?? []).map((i) => `${artist.id}/${i.name}`);

    console.log(`- ${artist.catalog_code} : ${files.length} fichier(s) audio, ${imagePaths.length} image(s)`);
    if (!apply) continue;

    try {
      await removeFromBucket(AUDIO_BUCKET, files.map((f) => f.storage_key));
      await removeFromBucket(IMAGE_BUCKET, imagePaths);
      const stamp = new Date().toISOString();
      if (files.length > 0) {
        const { error: markError } = await supabaseAdmin
          .from("track_files")
          .update({ purged_at: stamp })
          .in("id", files.map((f) => f.id));
        if (markError) throw markError;
      }
      const { error: artistError } = await supabaseAdmin.from("artists").update({ purged_at: stamp }).eq("id", artist.id);
      if (artistError) throw artistError;
      console.log(`  purgé`);
    } catch (err) {
      // Un artiste en échec n'arrête pas les autres ; il sera retenté au prochain passage.
      console.error(`  ÉCHEC ${artist.catalog_code}:`, err instanceof Error ? err.message : err);
    }
  }
  if (!apply && due.length > 0) console.log("\n(simulation : rien n'est supprimé ; --apply pour purger)");
}

async function main() {
  console.log(apply ? "MODE : APPLICATION (supprime des fichiers)" : "MODE : SIMULATION (ne supprime rien)");
  if (values["sweep-orphans"]) await sweepOrphans();
  await purgeDue();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
