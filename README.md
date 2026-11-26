# Isekaz Collection

Site de collectionneur manga : catalogue des séries réelles avec les ISBN de chaque tome.

- **Site** : `index.html` (GitHub Pages), lit la base Supabase en lecture seule.
- **Base** : Supabase, projet `isekai-collection` (tables `series` et `volumes`, voir `supabase/schema.sql`).
- **Recherche à la volée** : `supabase/functions/recherche` (fonction Supabase). Si une série ou un ISBN n'est pas encore dans la base, elle le cherche sur Google Books / Open Library et l'ajoute pour tout le monde.
- **Comptes et collection** : connexion par e-mail, pseudo et niveau (1 niveau tous les 10 tomes), pour chaque tome « je l'ai », nombre d'exemplaires (doubles) et liste de souhaits.
- **Import des ISBN en masse** : `scripts/import_isbn.py`, qui lit le site de l’éditeur (Glénat), Google Books ou le catalogue BnF.

## Mise en route (une seule fois)

1. **Secrets GitHub** : *Settings → Secrets and variables → Actions → New repository secret*
   - `SUPABASE_URL` = `https://rohiqowmjtcrrailkgdb.supabase.co`
   - `SUPABASE_SERVICE_KEY` = la clé **secrète** `sb_secret_…` (ou l'ancienne clé service_role), dans Supabase → Project Settings → API Keys.
     ⚠️ Cette clé est secrète : jamais dans `index.html` ni dans un commit.
2. **Clé Google Books** (gratuite, 1000 recherches/jour) : Google Cloud Console → activer « Books API » → Identifiants → Créer une clé API. Puis dans Supabase → Edge Functions → Secrets : `GOOGLE_BOOKS_KEY` = cette clé.
3. **Adresse du site pour les e-mails de connexion** : Supabase → Authentication → URL Configuration → Site URL = `https://lazynk.github.io/Isekaz-Collection/`.
4. **GitHub Pages** : *Settings → Pages → Source : Deploy from a branch → `main` / root*.

## Ajouter une série

Onglet **Actions → « Importer une série (ISBN) » → Run workflow**, puis remplir :
titre, éditeur, édition (si plusieurs éditions existent), nombre de tomes.
Coche « Test à blanc » la première fois pour vérifier ce qui sera importé sans rien écrire.

Le script :
- garde un seul ISBN par tome et signale les cas douteux (plusieurs ISBN pour un même tome) ;
- liste les tomes qu'il n'a pas trouvés ;
- ne remplace jamais un ISBN déjà présent dans la base.

En local :

```bash
pip install requests
python scripts/import_isbn.py --titre "Dragon Ball" --editeur "Glénat" --edition "Édition originale" --nb-tomes 42 --dry-run
```
