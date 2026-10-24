// Test de charge en LECTURE SEULE sur les routes publiques de l'API (catalogue) : combien de requêtes par seconde
// tient l'API (et la base derrière), et avec quelles durées de réponse.
//
//   npm run loadtest -- --url=http://localhost:4000 --concurrency=10 --seconds=20
//
// Garde-fous : aucune cible par défaut ; concurrence et durée plafonnées ; la production (vynl.ch, onrender.com)
// demande --allow-production. Ce script n'écrit RIEN : pas de compte, pas d'écoute, pas de battement.
//
// Ce qu'il ne mesure PAS : le chemin d'un battement de lecture (jeton, statut du compte, écritures en base), qui
// demande des comptes de test (l'API limite à un flux ouvert par compte et 300 requêtes par minute et par jeton).
// À faire sur l'environnement de test, avec des comptes créés pour l'occasion, jamais sur la production.
import { parseLoadArgs, summarize, type Sample } from "../lib/loadStats";

const PATHS = ["/health", "/tracks?limit=20", "/albums?limit=20", "/artists?limit=20"];

async function main() {
  const args = parseLoadArgs(process.argv.slice(2));
  console.log(`Cible : ${args.url} · ${args.concurrency} requêtes en parallèle · ${args.seconds} s · lecture seule`);

  const samples: Sample[] = [];
  const deadline = performance.now() + args.seconds * 1000;
  let next = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const path = PATHS[next++ % PATHS.length];
      const started = performance.now();
      let status = 0;
      try {
        const response = await fetch(args.url + path, { signal: AbortSignal.timeout(30_000) });
        await response.arrayBuffer();
        status = response.status;
      } catch {
        status = 0;
      }
      samples.push({ ms: performance.now() - started, status });
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  const seconds = (performance.now() - started) / 1000;

  const summary = summarize(samples, seconds);
  console.log(`\n${summary.requests} requêtes en ${seconds.toFixed(1)} s : ${summary.perSecond.toFixed(1)} par seconde`);
  console.log(`Durée de réponse : médiane ${summary.p50.toFixed(0)} ms · p95 ${summary.p95.toFixed(0)} ms · p99 ${summary.p99.toFixed(0)} ms · max ${summary.max.toFixed(0)} ms`);
  console.log(`Erreurs : ${summary.errors} (${(summary.errorRate * 100).toFixed(1)} %) · statuts : ${JSON.stringify(summary.statuses)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
