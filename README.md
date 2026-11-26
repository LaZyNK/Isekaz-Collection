# Isekaz Collection

Site de collectionneur manga : catalogue des séries réelles avec les ISBN de chaque tome.

- **Site** : `index.html` (GitHub Pages), lit la base Supabase en lecture seule.
- **Base** : Supabase, projet `isekai-collection` (tables `series` et `volumes`, voir `supabase/schema.sql`).
- **Import des ISBN** : `scripts/import_isbn.py`, qui interroge le catalogue de la BnF (dépôt légal, gratuit).

## Mise en route (une seule fois)

1. **Secrets GitHub** : *Settings → Secrets and variables → Actions → New repository secret*
   - `SUPABASE_URL` = `https://rohiqowmjtcrrailkgdb.supabase.co`
   - `SUPABASE_SERVICE_KEY` = la clé **service_role** (Supabase → Project Settings → API Keys).
     ⚠️ Cette clé est secrète : jamais dans `index.html` ni dans un commit.
2. **GitHub Pages** : *Settings → Pages → Source : Deploy from a branch → `main` / root*.

## Ajouter une série

Onglet **Actions → « Importer une série (ISBN BnF) » → Run workflow**, puis remplir :
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
