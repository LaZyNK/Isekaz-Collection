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
