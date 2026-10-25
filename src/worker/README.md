# Worker de transcodage

Prend chaque fichier audio original (bucket Supabase `track-audio`), en tire **deux versions AAC** (128 et 256 kbit/s, démarrage rapide) qu'il dépose dans le bucket R2 `vynlmusic`. `POST /plays` donne alors l'adresse du CDN (`cdn.vynl.li`) au lieu de celle de Supabase. L'original n'est jamais modifié.

```
upload du créateur ──► track_files ──(déclencheur)──► transcode_jobs ──► ce worker ──► R2 + track_renditions
                                                                                          │
POST /plays ◄── adresse signée du CDN si une version existe, sinon Supabase ◄─────────────┘
```

## Ce que fait la base (migration `20261025000000_audio_renditions.sql`)

- Chaque nouveau fichier crée sa tâche ; les fichiers déjà présents reçoivent la leur à l'application de la migration.
- Un worker **prend** une tâche avec un bail de 20 minutes : s'il plante, la tâche est reprise ; trois essais, avec 5 puis 10 minutes d'attente, puis la tâche passe en `failed` (visible sur la page System de l'admin).
- Supprimer un fichier, un morceau, une release, ou purger un artiste **inscrit les clés R2 concernées** dans `cdn_object_deletions` ; le worker les supprime de R2. Aucun fichier orphelin.

## Ce que fait le worker

Une boucle : vider la file de suppression, prendre la plus ancienne tâche, télécharger l'original, encoder, **vérifier la durée** (à 2 secondes près de l'original, sinon la version est refusée), déposer sur R2, inscrire en base. Plusieurs copies peuvent tourner ensemble. Une version déjà prête n'est pas refaite.

## Mise en place sur Render (une fois)

1. **Appliquer la migration** `supabase/migrations/20261025000000_audio_renditions.sql` dans le SQL Editor de Supabase (avant tout).
2. **Cloudflare > R2 > Manage API tokens > Create API token** : droit **Object Read & Write**, limité au bucket `vynlmusic`. Cloudflare affiche UNE FOIS l'*Access Key ID* et le *Secret Access Key* : les coller directement dans Render, nulle part ailleurs. L'*Account ID* est affiché à droite de la page R2.
3. **Render > New > Background Worker**, même dépôt que l'API, même région (Frankfurt) :
   - Build command : `npm install && npm run build`
   - Start command : `npm run worker:transcode`
   - Environment : `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (mêmes valeurs que l'API), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Page **System** de l'admin, section « Audio delivery » : la file se vide, « Tracks served by the CDN » monte.
5. Quand les versions sont prêtes : sur le service **API** de Render, ajouter `CDN_BASE_URL=https://cdn.vynl.li` (le `CDN_TOKEN_SECRET` y est déjà). Le CDN est actif à partir de là.

**Retour arrière** : vider `CDN_BASE_URL` sur l'API, l'écoute repasse par Supabase aussitôt. Le worker peut être suspendu sans effet sur l'écoute.

## Vérifier à la main

Dans le navigateur (onglet Réseau), lancer un morceau : la requête audio part vers `cdn.vynl.li` et répond `206` à chaque avance dans le morceau. Une adresse modifiée d'un caractère répond `403`.

## Commandes

```
npm run build              compile (dist/worker/main.js)
npm run worker:transcode   lance le worker (Render le fait ; pas en local sans clés R2)
npm test                   tests de la logique (sans réseau) et de ffmpeg (réel, avec ffmpeg-static)
```
