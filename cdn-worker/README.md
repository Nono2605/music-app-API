# CDN audio (cdn.vynl.li)

Un Worker Cloudflare qui sert les fichiers AAC du bucket R2 `vynlmusic`, **seulement à qui présente une adresse signée par l'API**. Le bucket reste privé : rien n'y est lisible sans ce Worker.

```
https://cdn.vynl.li/<clé>?e=<expiration, secondes Unix>&s=<signature>
signature = base64url( HMAC-SHA256( CDN_TOKEN_SECRET, "<clé>\n<expiration>" ) )
```

L'API signe (`src/lib/cdnToken.ts`), le Worker vérifie (`src/worker.js`). Les deux ont le même vecteur de test : si l'un change, l'autre doit changer.

## Ce qu'il fait

- Adresse fausse, modifiée, expirée ou pour un autre fichier : **403**. Secret non réglé : **503**.
- Le fichier est gardé dans le cache du serveur Cloudflare le plus proche, **sous une clé sans le jeton** : chaque nouveau jeton profite de la même copie. Les plages d'octets (avancer dans un morceau) sont servies depuis le cache ; au tout premier passage, la plage vient de R2 et le fichier entier est mis en cache en tâche de fond.
- Une clé de fichier ne change jamais (une nouvelle version a une nouvelle clé) : cache d'un an, immuable.
- GET, HEAD et OPTIONS seulement. CORS ouvert (les adresses sont signées).

## Mise en place (une fois, dans le tableau de bord Cloudflare)

1. **R2** : crée le bucket `vynlmusic` (Europe de l'Ouest), et **laisse-le privé** : ni domaine public, ni adresse `r2.dev`.
2. **Workers & Pages** : Create, Create Worker, nom `vynl-cdn`, Deploy. Puis Edit code : remplace tout par le contenu de `src/worker.js`, puis Deploy.
3. **Settings, Bindings** : Add, R2 bucket. Nom de la variable : `AUDIO` ; bucket : `vynlmusic`.
4. **Settings, Variables and Secrets** : Add, type **Secret**, nom `CDN_TOKEN_SECRET`, la valeur choisie (la même que `CDN_TOKEN_SECRET` sur l'API).
5. **Settings, Domains & Routes** : Add, Custom domain : `cdn.vynl.li`.
6. Test : `curl -i https://cdn.vynl.li/t/x/y.m4a` doit répondre **403** (pas de jeton). Un **503** veut dire que le secret n'est pas réglé.

## Tests

```
npm run test:worker
```
