# Pro-Num-TLD (Projet numerique TafLeaDer)

Application de gestion de groupe : membres, activités, finances, cotisations, présence, messagerie, appels et publications.

## Identité

- Nom affiché : **Pro-Num-TLD**
- Nom complet : **Projet numerique TafLeaDer**
- Domaine web : `https://pro-num-tld.pages.dev`
- Dépôt GitHub : `https://github.com/hariniainatafita/pro-num-tld`
- Package Android : `mg.pro.num.tld`
- Logo source : `src/tld-logo.png`

## Stack

- React 18 + TypeScript + Vite
- Capacitor 7 (Android)
- Cloudflare Pages + Functions
- Supabase / Neon pour la synchronisation
- R2 ou Supabase Storage pour les médias

## Développement

```powershell
npm install
npm run dev
```

## Build web

```powershell
npm run build
npm run preview
```

## Android

```powershell
npm run cap:sync
npm run apk:release
npm run aab:play
```

## Regénérer le logo et les icônes

Le logo est décliné en favicon, icônes PWA, icônes Android, icônes adaptatives et écrans de démarrage :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\generate_icons.ps1
```

## Vérifications

```powershell
npm run lint
npm run build
```

## Synchronisation multi-fournisseurs (bascule automatique)

Les donnees partagees (table virtuelle `app_state`) peuvent etre stockees sur
plusieurs services gratuits a la fois. Le proxy `functions/api/db/[[path]].js` :

- ecrit chaque modification sur TOUS les fournisseurs disponibles ;
- lit en priorite le premier fournisseur qui contient les cles demandees, puis
  bascule automatiquement si une base est vide, pleine (quota) ou en panne ;
- met un fournisseur en quarantaine 60 s apres un echec ;
- si toutes les ecritures echouent, supprime les images les plus anciennes
  (messages, stories, publications, avatars) puis reessaie. Les collections
  metier (membres, groupes, finances, mots de passe...) ne sont jamais
  supprimees.

Fournisseurs supportes : Cloudflare D1, Firebase Realtime Database, Upstash
Redis, Neon et Supabase. Voir `.env.example` pour toutes les variables.

### Mise en place

1. Cloudflare Dashboard > Workers & Pages > D1 : creer une base.
2. Pages > pro-num-tld > Settings > Functions > D1 bindings :
   `DB` -> la base creee (la table est creee automatiquement).
3. (Optionnel) Ajouter Firebase RTDB / Upstash / Neon avec les variables
   `FIREBASE_RTDB_URL`, `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`,
   `NEON_DATABASE_URL`.
4. Pages > pro-num-tld > Settings > Environment variables :
   `SUPABASE_PROJECTS` = liste JSON des fournisseurs, priorite croissante.
   Exemple :

   ```json
   [
     {"name":"d1","url":"https://pro-num-tld.pages.dev/api/d1/0","priority":1},
     {"name":"firebase","url":"https://pro-num-tld.pages.dev/api/firebase/0","priority":2},
     {"name":"upstash","url":"https://pro-num-tld.pages.dev/api/upstash/0","priority":3},
     {"name":"supabase","url":"https://xxxx.supabase.co","anonKey":"...","priority":4}
   ]
   ```

5. Ajouter le secret GitHub `VITE_SUPABASE_PROXY_URL` =
   `https://pro-num-tld.pages.dev/api/db` puis relancer le workflow.
6. Verifier l'etat : `https://pro-num-tld.pages.dev/api/db/health`.

Sans `VITE_SUPABASE_PROXY_URL`, l'application reste en connexion directe
(comportement precedent).

## Ressources externes à provisionner après renommage

- Projet Cloudflare Pages : `pro-num-tld`
- Bucket R2 : `pro-num-tld-media`
- Bucket Supabase Storage : `pro-num-tld-media`
- Secrets GitHub : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PROXY_URL`
