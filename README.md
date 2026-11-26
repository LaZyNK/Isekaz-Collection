# Isekaz Collection

Site de collectionneur manga : catalogue des séries réelles avec les ISBN de chaque tome.

- **Site** : `index.html` (GitHub Pages), lit la base Supabase en lecture seule.
- **Base** : Supabase, projet `isekai-collection` (tables `series` et `volumes`, voir `supabase/schema.sql`).
- **Recherche à la volée** : `supabase/functions/recherche` (fonction Supabase). Si une série ou un ISBN n'est pas encore dans la base, elle le cherche sur Google Books / Open Library et l'ajoute pour tout le monde.
- **International** : chaque série a la langue de son édition (FR, EN, DE…) ; le site propose un filtre par langue d'édition et l'interface existe en français et en anglais (`I18N` dans `index.html` pour ajouter une langue).
- **Scanner et fiche produit** : bouton rond en bas à droite. Caméra (détecteur intégré du navigateur, ou ZXing sur iPhone) ou saisie de l'ISBN. La fiche montre titre, éditeur, ISBN, date (avec compte à rebours si pas encore sorti), prix, description et les boutons collection / doubles / souhaits. Sans réseau, un ISBN inconnu est gardé « à identifier » puis traité au retour du réseau.
- **Hors ligne et application installable** : `sw.js` garde le site, les polices et les couvertures ; la page garde une copie du catalogue et de la collection (IndexedDB). Les changements faits sans réseau sont envoyés au retour du réseau. Bouton « Installer » pour l'ajouter à l'écran d'accueil (`manifest.webmanifest`).
- **Comptes et collection** : connexion par e-mail, pseudo et niveau (1 niveau tous les 10 tomes), pour chaque tome « je l'ai », nombre d'exemplaires (doubles) et liste de souhaits.
- **Suivi de lecture** : bouton « Marquer comme lu » sur la fiche d'un tome, onglet « Pile à lire » dans la collection.
- **Genres** : `supabase/functions/genres` récupère les genres et le public (shōnen…) d'une œuvre sur AniList la première fois qu'on l'ouvre ; filtre « Genre » dans le catalogue.
- **Planning des sorties** : onglet Planning (mes séries / tout, par semaine, compte à rebours, export agenda .ics), pastille et notification pour les sorties de la semaine dans ses séries (quand le site est ouvert).
- **Suivre une série et pointer vite** : sous chaque édition, « 🔔 Suivre » (ses prochains tomes arrivent dans le planning et les alertes) et « ☑ Pointer mes tomes » (bande de numéros à toucher, mode plage, Tout/Aucun, un seul enregistrement).
- **Lens** : dans le scanner, photo d'une couverture sans code-barres ; le site lit le texte (Tesseract.js) et propose les séries correspondantes.
- **Profil, succès et classement** : onglet Profil (niveau, 20 succès, profil public ou non, présentation, lien `#u=pseudo`), classement des profils publics (fonction `classement`).
- **Import des ISBN en masse** : `scripts/import_isbn.py`, qui lit le site de l’éditeur (Glénat), Google Books ou le catalogue BnF.

## Pré-remplir le catalogue (tous les mangas publiés en France)

Onglet **Actions → « Pré-remplir le catalogue (BnF) » → Run workflow** : choisis les éditeurs (« tous » ou par ex. `Pika,Kana`) et les années.
Laisse « Test à blanc » coché la première fois pour voir ce qui serait importé. Chaque lundi, l'action ajoute aussi toute seule les nouveautés.
Tout ce qu'elle crée est marqué `source = 'bnf'` ; un ISBN déjà présent n'est jamais modifié.

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
