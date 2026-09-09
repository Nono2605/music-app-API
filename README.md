# musicAPI

Backend centralisé de BRAND — API REST unique consommée par l'app web et,
plus tard, l'app mobile. Voir
[`../documentation/architecture/ARCHITECTURE.md`](../documentation/architecture/ARCHITECTURE.md)
pour le contexte complet (ce fichier n'existe que si le dossier
`documentation/` a été recréé — sinon se référer aux échanges précédents).

## Stack

Node.js / Express / TypeScript. Un seul backend, pas de microservices.
Source de vérité des données : Supabase (PostgreSQL), jamais dupliquée.

## Structure

```
src/
├── index.ts              # point d'entrée, démarre le serveur HTTP
├── app.ts                # config Express (middlewares, montage des routes)
├── config/env.ts         # lecture + validation des variables d'environnement
├── lib/supabaseAdmin.ts  # client Supabase (clé service_role, serveur only)
├── middleware/
│   ├── auth.ts            # vérifie le JWT Supabase, attache req.auth
│   └── errorHandler.ts    # 404 + gestion d'erreur centralisée
├── routes/index.ts        # monte tous les routers de modules
└── modules/
    ├── users/              # GET /me (exemple : route authentifiée)
    ├── artists/            # GET /artists, /artists/:slug (exemple : route publique)
    └── tracks/             # GET /tracks/:id (exemple : route publique)

supabase/migrations/       # schéma SQL (déjà appliqué à la base)
```

Chaque nouveau domaine (albums, playlists, subscriptions, royalties,
ai_declarations, rights, fraud...) suit le même pattern : un dossier dans
`src/modules/<domaine>/routes.ts`, monté dans `src/routes/index.ts`.

## Démarrer en local

```bash
npm install
cp .env.example .env
```

Remplir `.env` avec les valeurs du dashboard Supabase (Project Settings >
API) : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

```bash
npm run dev
```

Le serveur démarre sur `http://localhost:4000` (`PORT` dans `.env`).

## Vérifier

```bash
curl http://localhost:4000/health
```

## Authentification

Chaque requête protégée attend `Authorization: Bearer <JWT>` — le JWT
émis par Supabase Auth côté client (web/mobile). Le middleware
`requireAuth` (`src/middleware/auth.ts`) le valide auprès de Supabase et
attache `req.auth = { id, email }`. Le rôle applicatif (`listener` /
`creator` / `admin`) se lit dans `public.users`, pas dans le token.

## Déploiement (Render)

`musicAPI` est un serveur Express classique (pas serverless) — Render le fait
tourner tel quel, sans adaptation de code.

1. Pousser ce dossier sur un repo GitHub dédié.
2. Sur [render.com](https://render.com) → New → Blueprint → sélectionner le
   repo. `render.yaml` définit déjà build/start commands.
   - Si le service a été créé via "New Web Service" (formulaire manuel)
     plutôt que via Blueprint, `render.yaml` n'est pas lu : renseigner à la
     main **Build Command** = `npm install --include=dev && npm run build`
     et **Start Command** = `npm start`. Le `--include=dev` est nécessaire
     car `NODE_ENV=production` fait sauter les `devDependencies`
     (TypeScript, `@types/*`) par défaut — sans ça, `tsc` échoue.
3. Renseigner dans le dashboard Render (jamais dans `render.yaml`, jamais
   commité) : `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CORS_ALLOWED_ORIGINS`
   (domaines Vercel du site et de l'app, séparés par des virgules).
4. Render fournit `PORT` automatiquement — déjà géré par
   [`src/config/env.ts`](src/config/env.ts).

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` ne doit jamais être exposée à un client
  (web, mobile, logs, repo). Utilisée uniquement côté serveur ici.
- Toutes les tables Supabase ont RLS activée sans policy : seul ce
  backend (clé service_role) peut y lire/écrire.
- Aucune clé/secret en dur dans le code — tout passe par `.env`
  (non commité, voir `.gitignore`).
