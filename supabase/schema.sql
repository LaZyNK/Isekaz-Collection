-- Schéma de la base Isekaz Collection (déjà appliqué sur le projet Supabase "isekai-collection").
-- Gardé ici pour référence ou pour recréer la base.

create table public.series (
  id bigint generated always as identity primary key,
  titre text not null,
  edition text,
  editeur text,
  auteur text,
  nb_tomes int,
  statut text,
  created_at timestamptz default now(),
  unique (titre, edition, editeur)
);

create table public.volumes (
  id bigint generated always as identity primary key,
  serie_id bigint not null references public.series(id) on delete cascade,
  numero int not null,
  titre text,
  isbn13 text unique,
  date_parution date,
  couverture_url text,
  created_at timestamptz default now(),
  unique (serie_id, numero)
);
create index on public.volumes (serie_id);

-- Lecture publique, écriture réservée à la clé service_role (script d'import).
alter table public.series enable row level security;
alter table public.volumes enable row level security;
create policy "lecture publique series" on public.series for select using (true);
create policy "lecture publique volumes" on public.volumes for select using (true);

-- ===== Comptes et collections (migration « comptes_et_collections ») =====
alter table public.series drop constraint if exists series_titre_edition_editeur_key;
alter table public.series add constraint series_titre_edition_editeur_key unique nulls not distinct (titre, edition, editeur);
alter table public.series add column if not exists source text default 'manuel';

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pseudo text unique not null check (char_length(pseudo) between 3 and 24),
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "profils visibles par tous" on public.profiles for select using (true);
create policy "modifier son profil" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, pseudo)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'pseudo', ''), 'membre-' || left(new.id::text, 8)));
  return new;
end $$;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- quantite : 0 = pas possédé, 1 = possédé, 2+ = possédé avec doubles ; souhait = liste de souhaits
create table public.collection (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  volume_id bigint not null references public.volumes(id) on delete cascade,
  quantite int not null default 0 check (quantite between 0 and 99),
  souhait boolean not null default false,
  updated_at timestamptz default now(),
  primary key (user_id, volume_id)
);
create index on public.collection (volume_id);
alter table public.collection enable row level security;
create policy "voir sa collection" on public.collection for select to authenticated using ((select auth.uid()) = user_id);
create policy "ajouter a sa collection" on public.collection for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "modifier sa collection" on public.collection for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "retirer de sa collection" on public.collection for delete to authenticated using ((select auth.uid()) = user_id);

create or replace view public.mes_stats with (security_invoker = true) as
select user_id,
       count(*) filter (where quantite > 0) as tomes_possedes,
       coalesce(sum(greatest(quantite - 1, 0)), 0) as doubles,
       count(*) filter (where souhait) as souhaits,
       1 + count(*) filter (where quantite > 0) / 10 as niveau
from public.collection group by user_id;

-- ===== Langue des éditions (migration « langue_des_editions ») =====
-- fr, en, de, it, es, ja… : sert au filtre « Langue de l'édition » du site.
alter table public.series add column if not exists langue text not null default 'fr';
create index if not exists series_langue_idx on public.series (langue);

-- ===== Fiche produit (migration « fiche_produit ») =====
alter table public.volumes add column if not exists description text;
alter table public.volumes add column if not exists prix numeric(8,2);
alter table public.volumes add column if not exists devise text;
alter table public.volumes add column if not exists fiche_maj timestamptz;

-- ===== Types, public, éditions spéciales, ajouts des membres (migration « types_public_editions_speciales ») =====
alter table public.series add column if not exists type text not null default 'manga'
  check (type in ('manga','light_novel','artbook','dvd','bluray','vhs','figurine','goodies','jeu_video','cd','autre'));
alter table public.series add column if not exists public text check (public in ('shonen','seinen','shojo','josei','kodomo'));
alter table public.series add column if not exists genres text[] not null default '{}';
alter table public.series add column if not exists ajoute_par uuid references auth.users(id) on delete set null;
alter table public.volumes add column if not exists variante text
  check (variante in ('collector','limitee','jaquette_alt','premier_tirage','jaquette_coffret_dvd','coffret','starter','bundle','autre'));
alter table public.volumes add column if not exists variante_nom text check (char_length(variante_nom) <= 120);
alter table public.volumes add column if not exists contenu text check (char_length(contenu) <= 200);
alter table public.volumes add column if not exists photo_url text;
alter table public.volumes add column if not exists ajoute_par uuid references auth.users(id) on delete set null;
alter table public.volumes drop constraint if exists volumes_serie_id_numero_key;
create unique index if not exists volumes_serie_numero_variante_key
  on public.volumes (serie_id, numero, coalesce(variante, ''), coalesce(variante_nom, ''));
-- + règles d'ajout pour les membres connectés et stockage « photos » (voir la migration dans Supabase)

-- ===== Suivi de lecture, profils publics, classement (migration « lecture_profils_classement ») =====
alter table public.collection add column if not exists lu boolean not null default false;
alter table public.collection add column if not exists lu_le timestamptz;
alter table public.profiles add column if not exists public boolean not null default false;
alter table public.profiles add column if not exists bio text check (char_length(bio) <= 280);
create policy "voir les collections publiques" on public.collection for select
  using (exists (select 1 from public.profiles p where p.id = collection.user_id and p.public));
create or replace function public.classement(limite int default 50)
returns table (pseudo text, tomes bigint, series bigint, doubles bigint, lus bigint)
language sql stable security invoker set search_path = '' as $$
  select p.pseudo,
         count(*) filter (where c.quantite > 0) as tomes,
         count(distinct v.serie_id) filter (where c.quantite > 0) as series,
         coalesce(sum(greatest(c.quantite - 1, 0)), 0) as doubles,
         count(*) filter (where c.lu) as lus
  from public.profiles p
  join public.collection c on c.user_id = p.id
  join public.volumes v on v.id = c.volume_id
  where p.public
  group by p.pseudo
  order by tomes desc, series desc
  limit least(greatest(limite, 1), 200);
$$;
grant execute on function public.classement(int) to anon, authenticated;

-- ===== Genres (migration « genres_maj ») : remplis par la fonction « genres » (AniList) =====
alter table public.series add column if not exists genres_maj timestamptz;
create index if not exists series_genres_idx on public.series using gin (genres);
create index if not exists volumes_date_idx on public.volumes (date_parution);

-- ===== Séries suivies (migration « suivis_series ») : prochains tomes dans le planning et les alertes =====
create table if not exists public.suivis (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  serie_id bigint not null references public.series(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, serie_id)
);
create index if not exists suivis_serie_idx on public.suivis (serie_id);
alter table public.suivis enable row level security;
create policy "voir ses suivis" on public.suivis for select to authenticated using ((select auth.uid()) = user_id);
create policy "suivre" on public.suivis for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "ne plus suivre" on public.suivis for delete to authenticated using ((select auth.uid()) = user_id);

-- ===== Compléter les tomes connus (migration « completer_volumes ») : couverture, date, prix, résumé venus de Google =====
-- Voir la migration dans Supabase : fonction public.completer_volumes(jsonb), réservée à la clé serveur.

-- ===== Profil (photo, bannière, réseaux) et autres titres (migration « profil_photos_reseaux_titres_alt ») =====
alter table public.profiles add column if not exists avatar_url text check (char_length(avatar_url) <= 500);
alter table public.profiles add column if not exists banniere_url text check (char_length(banniere_url) <= 500);
alter table public.profiles add column if not exists reseaux jsonb not null default '{}'::jsonb
  check (jsonb_typeof(reseaux) = 'object' and pg_column_size(reseaux) < 4000);
alter table public.series add column if not exists titres_alt text[] not null default '{}';
alter table public.series add column if not exists titres_maj timestamptz;
create index if not exists series_titres_alt_idx on public.series using gin (titres_alt);

-- ===== Couvertures (migration « series_a_illustrer ») : file des séries à compléter par Google Books, chaque jour =====
alter table public.series add column if not exists couv_maj timestamptz;
-- + fonction public.series_a_illustrer(limite) réservée à la clé serveur (voir la migration dans Supabase)

-- ===== Noms d'éditeurs unifiés (migration « editeurs_alias ») : « Comics USA » → Glénat, « Glénat Manga » → Glénat… =====
-- fonction public.editeur_canonique(text) + déclencheur series_editeur_canonique (avant insertion / changement d'éditeur)
