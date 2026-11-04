create extension if not exists pgcrypto;

create sequence if not exists public.fbs_enrollment_number_seq;
create sequence if not exists public.fbs_receipt_number_seq;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  first_name text not null default '',
  last_name text not null default '',
  phone text not null default '',
  role text not null default 'student' check (role in ('student', 'staff', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles
  where id = (select auth.uid()) and active = true
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() in ('staff', 'admin'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'admin', false)
$$;

create or replace function public.admin_set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'Seul un administrateur peut gérer les rôles.';
  end if;
  if new_role not in ('student', 'staff', 'admin') then
    raise exception 'Rôle non valide.';
  end if;
  update public.profiles set role = new_role where id = target_user_id;
  if not found then
    raise exception 'Compte introuvable.';
  end if;
  insert into public.activity_log (action, actor_id)
  values ('Modification du rôle de ' || target_user_id::text || ' en ' || new_role, (select auth.uid()));
end
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, first_name, last_name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.courses (
  id text primary key,
  name text not null,
  category text not null,
  price integer check (price is null or price >= 0),
  duration text not null default '',
  description text not null default '',
  registration_fee integer not null default 20000 check (registration_fee >= 0),
  fee_confirmed boolean not null default false,
  deposit_percent integer not null default 50 check (deposit_percent between 0 and 100),
  payment_plan_confirmed boolean not null default false,
  prerequisites text not null default '',
  required_documents text not null default '',
  active boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  course_id text not null references public.courses(id),
  name text not null,
  starts_at date not null,
  ends_at date,
  schedule text not null default '',
  location text not null default '',
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  enrollment_number text not null unique default (
    'FBS-' || to_char(current_date, 'YYYY') || '-' ||
    lpad(nextval('public.fbs_enrollment_number_seq')::text, 5, '0')
  ),
  student_id uuid not null references public.profiles(id),
  course_id text not null references public.courses(id),
  session_id uuid references public.sessions(id) on delete set null,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text not null default '',
  birth_date date,
  address text not null default '',
  availability text not null default '',
  emergency_contact text not null default '',
  status text not null default 'En attente'
    check (status in ('Brouillon', 'En attente', 'Pièces à compléter', 'Paiement à vérifier', 'Inscrit', 'Refusé', 'Formation terminée', 'Archivé')),
  status_comment text not null default '',
  accepted_terms boolean not null default false,
  course_price integer check (course_price is null or course_price >= 0),
  registration_fee integer not null default 0 check (registration_fee >= 0),
  registration_fee_confirmed boolean not null default false,
  payment_plan_confirmed boolean not null default false,
  deposit_percent integer not null default 50 check (deposit_percent between 0 and 100),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.enrollments
  add column if not exists status_comment text not null default '';

create or replace function public.guard_student_enrollment_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  course_record public.courses%rowtype;
begin
  if (select public.is_staff()) then
    if tg_op = 'INSERT' or new.course_id is distinct from old.course_id then
      select * into course_record from public.courses
        where id = new.course_id and active = true and archived = false;
      if not found then
        raise exception 'Cette formation n’est pas disponible.';
      end if;
      if tg_op = 'UPDATE' and exists (
        select 1 from public.payments p where p.enrollment_id = old.id
      ) then
        raise exception 'La formation ne peut pas être modifiée après l’enregistrement d’un paiement.';
      end if;
      new.course_price := course_record.price;
      new.registration_fee := case when course_record.fee_confirmed then course_record.registration_fee else 0 end;
      new.registration_fee_confirmed := course_record.fee_confirmed;
      new.payment_plan_confirmed := course_record.payment_plan_confirmed;
      new.deposit_percent := course_record.deposit_percent;
    end if;
    if new.session_id is not null and not exists (
      select 1 from public.sessions s
      where s.id = new.session_id and s.course_id = new.course_id and s.active = true
    ) then
      raise exception 'La session choisie ne correspond pas à la formation.';
    end if;
    if new.created_by is null then
      new.created_by := (select auth.uid());
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.student_id <> (select auth.uid()) or new.accepted_terms is not true then
      raise exception 'La demande doit appartenir à votre compte et les conditions doivent être acceptées.';
    end if;
    select * into course_record from public.courses
      where id = new.course_id and active = true and archived = false;
    if not found then
      raise exception 'Cette formation n’est pas disponible.';
    end if;
    if new.session_id is not null and not exists (
      select 1 from public.sessions s
      where s.id = new.session_id and s.course_id = new.course_id and s.active = true
    ) then
      raise exception 'La session choisie ne correspond pas à la formation.';
    end if;
    new.created_by := (select auth.uid());
    new.status := 'En attente';
    new.course_price := course_record.price;
    new.registration_fee := case when course_record.fee_confirmed then course_record.registration_fee else 0 end;
    new.registration_fee_confirmed := course_record.fee_confirmed;
    new.payment_plan_confirmed := course_record.payment_plan_confirmed;
    new.deposit_percent := course_record.deposit_percent;
    return new;
  end if;

  if old.student_id <> (select auth.uid())
    or new.id is distinct from old.id
    or new.student_id is distinct from old.student_id
    or new.course_id is distinct from old.course_id
    or new.session_id is distinct from old.session_id
    or new.status is distinct from old.status
    or new.status_comment is distinct from old.status_comment
    or new.accepted_terms is distinct from old.accepted_terms
    or new.course_price is distinct from old.course_price
    or new.registration_fee is distinct from old.registration_fee
    or new.registration_fee_confirmed is distinct from old.registration_fee_confirmed
    or new.payment_plan_confirmed is distinct from old.payment_plan_confirmed
    or new.deposit_percent is distinct from old.deposit_percent
    or new.created_by is distinct from old.created_by
    or new.enrollment_number is distinct from old.enrollment_number
    or new.created_at is distinct from old.created_at then
    raise exception 'Vous ne pouvez modifier que vos coordonnées sur cette demande.';
  end if;
  return new;
end
$$;

drop trigger if exists enrollments_guard_student_changes on public.enrollments;
create trigger enrollments_guard_student_changes
before insert or update on public.enrollments
for each row execute function public.guard_student_enrollment_changes();

create table if not exists public.enrollment_status_history (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  status text not null,
  comment text not null default '',
  changed_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create or replace function public.assign_payment_receipt_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'Validé' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if new.receipt_number is null then
      new.receipt_number := 'FBS-REC-' || to_char(current_date, 'YYYY') || '-' ||
        lpad(nextval('public.fbs_receipt_number_seq')::text, 6, '0');
    end if;
    new.validated_by := coalesce((select auth.uid()), new.validated_by);
    new.validated_at := coalesce(new.validated_at, now());
  end if;
  return new;
end
$$;

create or replace function public.audit_payment_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.activity_log (action, actor_id)
  values (
    case when tg_op = 'INSERT' then 'Enregistrement du paiement ' else 'Mise à jour du paiement ' end
      || new.id::text || ' (' || new.status || ')',
    coalesce((select auth.uid()), new.entered_by)
  );
  return new;
end
$$;

create or replace function public.audit_enrollment_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  course_name text;
  notification_message text;
  notification_channel text;
  notification_enabled boolean;
  actor_id uuid;
begin
  actor_id := coalesce((select auth.uid()), new.created_by);
  if tg_op = 'INSERT' or old.status is distinct from new.status or old.status_comment is distinct from new.status_comment then
    insert into public.enrollment_status_history (enrollment_id, status, comment, changed_by)
    values (new.id, new.status, new.status_comment, actor_id);

    if actor_id is not null then
      insert into public.activity_log (action, actor_id)
      values (
        case when tg_op = 'INSERT' then 'Création de la demande ' else 'Changement de statut de la demande ' end
          || new.enrollment_number || ' : ' || new.status,
        actor_id
      );
    end if;

    if tg_op = 'INSERT' then
      select name into course_name from public.courses where id = new.course_id;
      select body, channel, enabled into notification_message, notification_channel, notification_enabled
      from public.notification_templates where id = 'demande_recue';
      insert into public.notifications (student_id, enrollment_id, template_id, event_type, channel, message, delivery_status, created_by)
      values (
        new.student_id, new.id, 'demande_recue', 'Demande reçue', coalesce(notification_channel, 'e-mail et SMS'),
        replace(coalesce(notification_message, 'Votre demande pour la formation {{formation}} a bien été reçue.'), '{{formation}}', coalesce(course_name, 'choisie')),
        case when coalesce(notification_enabled, true) then 'Fournisseur e-mail/SMS à configurer' else 'Désactivée par le centre' end,
        actor_id
      );
    end if;
  end if;
  return new;
end
$$;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  amount integer not null check (amount > 0),
  paid_at date not null default current_date,
  method text not null,
  reference text not null default '',
  comment text not null default '',
  status text not null default 'À vérifier' check (status in ('À vérifier', 'Validé', 'Refusé')),
  entered_by uuid references public.profiles(id),
  validated_by uuid references public.profiles(id),
  validated_at timestamptz,
  receipt_number text unique,
  created_at timestamptz not null default now()
);

alter table public.payments
  add column if not exists receipt_number text unique;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid references public.enrollments(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  document_type text not null check (document_type in ('photo', 'justificatif', 'recu', 'attestation', 'ressource', 'autre')),
  name text not null,
  storage_path text not null unique,
  mime_type text not null,
  visible_to_student boolean not null default true,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create unique index if not exists one_photo_per_enrollment_idx
  on public.documents(enrollment_id)
  where document_type = 'photo' and enrollment_id is not null;

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'Ressource de cours',
  description text not null default '',
  storage_path text not null unique,
  course_id text references public.courses(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete cascade,
  target_student_id uuid references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (num_nonnulls(course_id, session_id, target_student_id) = 1)
);

create or replace function public.is_student_upload_unreferenced(file_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (storage.foldername(file_path))[1] = (select auth.uid())::text
    and not exists (select 1 from public.documents where storage_path = file_path)
    and not exists (select 1 from public.resources where storage_path = file_path)
$$;

create table if not exists public.resource_downloads (
  id bigint generated always as identity primary key,
  resource_id uuid not null references public.resources(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  downloaded_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  published boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.notification_templates (
  id text primary key,
  name text not null,
  channel text not null default 'e-mail et SMS',
  subject text not null default '',
  body text not null,
  enabled boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  enrollment_id uuid references public.enrollments(id) on delete cascade,
  template_id text references public.notification_templates(id) on delete set null,
  event_type text not null,
  channel text not null default 'e-mail et SMS',
  message text not null,
  delivery_status text not null default 'Fournisseur à configurer',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

alter table public.notifications
  add column if not exists template_id text references public.notification_templates(id) on delete set null;

insert into public.notification_templates (id, name, channel, subject, body, enabled)
values
  ('demande_recue', 'Réception de la demande', 'e-mail et SMS', 'Demande reçue — FBS GROUPE', 'Votre demande pour la formation {{formation}} a bien été reçue. Statut : En attente de vérification.', true),
  ('correction', 'Dossier à compléter', 'e-mail et SMS', 'Dossier à compléter — FBS GROUPE', 'Votre dossier pour {{formation}} nécessite une correction. Connectez-vous pour consulter les pièces demandées.', true),
  ('inscription_confirmee', 'Inscription confirmée', 'e-mail et SMS', 'Félicitations pour votre inscription — FBS GROUPE', 'Félicitations pour votre inscription à la formation {{formation}} !', true),
  ('refus', 'Demande refusée', 'e-mail et SMS', 'Mise à jour de votre demande — FBS GROUPE', 'Votre demande pour {{formation}} a été refusée. Contactez le centre pour plus d’informations.', true),
  ('statut', 'Mise à jour du statut', 'e-mail et SMS', 'Mise à jour de votre dossier — FBS GROUPE', 'Le statut de votre demande pour {{formation}} est maintenant « {{statut}} ».', true),
  ('paiement_recu', 'Paiement reçu', 'e-mail et SMS', 'Paiement enregistré — FBS GROUPE', 'Un paiement de {{montant}} a été enregistré et doit encore être vérifié.', true),
  ('paiement_valide', 'Paiement validé', 'e-mail et SMS', 'Paiement validé — FBS GROUPE', 'Votre paiement de {{montant}} a été validé. Le reçu {{recu}} est disponible dans votre espace.', true),
  ('document_disponible', 'Document disponible', 'e-mail et SMS', 'Document disponible — FBS GROUPE', 'Un document « {{document}} » a été ajouté à votre espace.', true),
  ('ressource_disponible', 'Ressource disponible', 'e-mail et SMS', 'Ressource disponible — FBS GROUPE', 'Une ressource « {{ressource}} » est disponible dans votre espace.', true),
  ('rappel_echeance', 'Rappel d’échéance', 'e-mail et SMS', 'Rappel de paiement — FBS GROUPE', 'Un solde de {{solde}} est à régler pour {{formation}}. Contactez le centre pour connaître les modalités.', false)
on conflict (id) do nothing;

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  action text not null,
  actor_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

drop trigger if exists profiles_guard_student_changes on public.profiles;
create or replace function public.guard_profile_role_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role is distinct from new.role or old.active is distinct from new.active
    or old.id is distinct from new.id or old.email is distinct from new.email
    or old.created_at is distinct from new.created_at then
    if not (select public.is_admin()) then
      raise exception 'Vous ne pouvez modifier que vos coordonnées.';
    end if;
  end if;
  return new;
end
$$;
create trigger profiles_guard_student_changes
before update on public.profiles
for each row execute function public.guard_profile_role_changes();

create index if not exists enrollments_student_id_idx on public.enrollments(student_id);
create index if not exists enrollments_status_idx on public.enrollments(status);
create index if not exists enrollments_course_id_idx on public.enrollments(course_id);
create index if not exists payments_enrollment_id_idx on public.payments(enrollment_id);
create index if not exists documents_student_id_idx on public.documents(student_id);
create index if not exists notifications_student_id_idx on public.notifications(student_id);
create index if not exists status_history_enrollment_id_idx on public.enrollment_status_history(enrollment_id);
create index if not exists resource_downloads_student_id_idx on public.resource_downloads(student_id);

drop trigger if exists enrollments_audit_status on public.enrollments;
create trigger enrollments_audit_status
after insert or update of status, status_comment on public.enrollments
for each row execute function public.audit_enrollment_status();
drop trigger if exists payments_assign_receipt on public.payments;
create trigger payments_assign_receipt
before insert or update on public.payments
for each row execute function public.assign_payment_receipt_number();
drop trigger if exists payments_audit_operation on public.payments;
create trigger payments_audit_operation
after insert or update of status on public.payments
for each row execute function public.audit_payment_operation();
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
drop trigger if exists courses_set_updated_at on public.courses;
create trigger courses_set_updated_at before update on public.courses
for each row execute function public.set_updated_at();
drop trigger if exists sessions_set_updated_at on public.sessions;
create trigger sessions_set_updated_at before update on public.sessions
for each row execute function public.set_updated_at();
drop trigger if exists enrollments_set_updated_at on public.enrollments;
create trigger enrollments_set_updated_at before update on public.enrollments
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.sessions enable row level security;
alter table public.enrollments enable row level security;
alter table public.enrollment_status_history enable row level security;
alter table public.payments enable row level security;
alter table public.documents enable row level security;
alter table public.resources enable row level security;
alter table public.resource_downloads enable row level security;
alter table public.announcements enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_log enable row level security;
alter table public.notification_templates enable row level security;

drop policy if exists "Profiles visible to own user and staff" on public.profiles;
create policy "Profiles visible to own user and staff" on public.profiles
for select to authenticated using (id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists "Admins manage profiles" on public.profiles;
create policy "Admins manage profiles" on public.profiles
for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Users update own contact details" on public.profiles;
create policy "Users update own contact details" on public.profiles
for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "Active courses are public" on public.courses;
create policy "Active courses are public" on public.courses
for select to anon, authenticated using (active = true and archived = false);
drop policy if exists "Staff manage courses" on public.courses;
create policy "Staff manage courses" on public.courses
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Sessions visible to authenticated users" on public.sessions;
create policy "Sessions visible to authenticated users" on public.sessions
for select to authenticated using (active = true or (select public.is_staff()));
drop policy if exists "Staff manage sessions" on public.sessions;
create policy "Staff manage sessions" on public.sessions
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Students and staff read enrollments" on public.enrollments;
create policy "Students and staff read enrollments" on public.enrollments
for select to authenticated using (student_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists "Students create own enrollment" on public.enrollments;
create policy "Students create own enrollment" on public.enrollments
for insert to authenticated with check (
  student_id = (select auth.uid()) and created_by = (select auth.uid()) and status = 'En attente' and accepted_terms = true
);
drop policy if exists "Students update own pending enrollment" on public.enrollments;
create policy "Students update own pending enrollment" on public.enrollments
for update to authenticated using (
  student_id = (select auth.uid()) and status in ('En attente', 'Pièces à compléter')
) with check (
  student_id = (select auth.uid()) and status in ('En attente', 'Pièces à compléter')
);
drop policy if exists "Staff manage enrollments" on public.enrollments;
create policy "Staff manage enrollments" on public.enrollments
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Students and staff read status history" on public.enrollment_status_history;
create policy "Students and staff read status history" on public.enrollment_status_history
for select to authenticated using (
  (select public.is_staff()) or exists (
    select 1 from public.enrollments e where e.id = enrollment_id and e.student_id = (select auth.uid())
  )
);
drop policy if exists "Staff add status history" on public.enrollment_status_history;
create policy "Staff add status history" on public.enrollment_status_history
for insert to authenticated with check ((select public.is_staff()) and changed_by = (select auth.uid()));

drop policy if exists "Students and staff read payments" on public.payments;
create policy "Students and staff read payments" on public.payments
for select to authenticated using (student_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists "Staff manage payments" on public.payments;
create policy "Staff manage payments" on public.payments
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Students read their visible documents" on public.documents;
create policy "Students read their visible documents" on public.documents
for select to authenticated using (
  (select public.is_staff()) or (student_id = (select auth.uid()) and visible_to_student = true)
);
drop policy if exists "Staff manage documents" on public.documents;
create policy "Staff manage documents" on public.documents
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "Students add their own documents" on public.documents;
create policy "Students add their own documents" on public.documents
for insert to authenticated with check (
  student_id = (select auth.uid()) and uploaded_by = (select auth.uid()) and document_type in ('photo', 'justificatif')
  and (enrollment_id is null or exists (
    select 1 from public.enrollments e where e.id = enrollment_id and e.student_id = (select auth.uid())
  ))
);

drop policy if exists "Students read authorized resources" on public.resources;
create policy "Students read authorized resources" on public.resources
for select to authenticated using (
  (select public.is_staff()) or
  target_student_id = (select auth.uid()) or
  exists (
    select 1 from public.enrollments e
    where e.student_id = (select auth.uid())
      and e.status in ('Inscrit', 'Formation terminée')
      and ((course_id is not null and e.course_id = resources.course_id)
        or (session_id is not null and e.session_id = resources.session_id))
  )
);
drop policy if exists "Staff manage resources" on public.resources;
create policy "Staff manage resources" on public.resources
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Students record their own resource downloads" on public.resource_downloads;
create policy "Students record their own resource downloads" on public.resource_downloads
for insert to authenticated with check (
  student_id = (select auth.uid()) and exists (
    select 1 from public.resources r where r.id = resource_id
  )
);
drop policy if exists "Students and staff read resource download history" on public.resource_downloads;
create policy "Students and staff read resource download history" on public.resource_downloads
for select to authenticated using (student_id = (select auth.uid()) or (select public.is_staff()));

drop policy if exists "Published announcements are public" on public.announcements;
create policy "Published announcements are public" on public.announcements
for select to anon, authenticated using (published = true);
drop policy if exists "Staff manage announcements" on public.announcements;
create policy "Staff manage announcements" on public.announcements
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Students and staff read notifications" on public.notifications;
create policy "Students and staff read notifications" on public.notifications
for select to authenticated using (student_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists "Staff create notifications" on public.notifications;
create policy "Staff create notifications" on public.notifications
for insert to authenticated with check ((select public.is_staff()) and created_by = (select auth.uid()));

drop policy if exists "Staff manage notification templates" on public.notification_templates;
create policy "Staff manage notification templates" on public.notification_templates
for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "Staff read activity log" on public.activity_log;
create policy "Staff read activity log" on public.activity_log
for select to authenticated using ((select public.is_staff()));
drop policy if exists "Staff append activity log" on public.activity_log;
create policy "Staff append activity log" on public.activity_log
for insert to authenticated with check ((select public.is_staff()) and actor_id = (select auth.uid()));

grant usage on schema public to anon, authenticated;
grant select on public.courses, public.announcements to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.courses, public.sessions, public.enrollments,
  public.enrollment_status_history, public.payments, public.documents, public.resources,
  public.resource_downloads, public.announcements, public.notifications, public.notification_templates,
  public.activity_log to authenticated;
grant usage, select on sequence public.fbs_enrollment_number_seq to authenticated;
grant usage, select on sequence public.fbs_receipt_number_seq to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;
revoke all on function public.is_student_upload_unreferenced(text) from public;
grant execute on function public.is_student_upload_unreferenced(text) to authenticated;

insert into public.courses (id, name, category, price, duration, description, registration_fee, fee_confirmed, deposit_percent, payment_plan_confirmed)
values
  ('windows-word-excel', 'Windows - Word - Excel', 'Bureautique', 300000, '2 mois', 'Formation idéale pour apprendre les bases de l’ordinateur et de la bureautique.', 20000, false, 50, false),
  ('powerpoint-publisher', 'PowerPoint - Publisher', 'Bureautique', 300000, '1 mois', 'Création de présentations, affiches, cartes et supports professionnels.', 20000, false, 50, false),
  ('access', 'Access', 'Bureautique', 350000, '1 mois', 'Création et gestion de bases de données simples.', 20000, false, 50, false),
  ('outlook', 'Outlook', 'Bureautique', 100000, '1 semaine', 'Gestion des e-mails, du calendrier, des rendez-vous et de la communication professionnelle.', 20000, false, 50, false),
  ('exploitation-internet', 'Exploitation Internet', 'Bureautique', 150000, '1 semaine', 'Navigation, recherche d’informations et utilisation des outils numériques.', 20000, false, 50, false),
  ('tap-touch', 'Tap Touch', 'Bureautique', 100000, '1 mois', 'Formation pour améliorer la vitesse et la précision de frappe au clavier.', 20000, false, 50, false),
  ('excel-avance', 'Excel avancé', 'Logiciels avancés', 350000, '1 mois', 'Fonctions avancées, tableaux, calculs, organisation et traitement des données.', 20000, false, 50, false),
  ('powerpoint-avance', 'PowerPoint avancé', 'Logiciels avancés', 150000, '2 semaines', 'Création de présentations modernes avec animations et supports multimédias.', 20000, false, 50, false),
  ('publipostage-references', 'Publipostage et références', 'Logiciels avancés', 150000, '2 semaines', 'Création automatique de lettres, listes, références et documents administratifs.', 20000, false, 50, false),
  ('spss-statistic-v21', 'SPSS Statistic v21', 'Logiciels statistiques et comptables', 300000, '1 mois', 'Analyse statistique de données pour étudiants, chercheurs et professionnels.', 20000, false, 50, false),
  ('sage-comptabilite-i7', 'SAGE Comptabilité i7', 'Logiciels statistiques et comptables', 400000, '1 mois 1 semaine', 'Apprentissage de la comptabilité informatisée et de la gestion comptable.', 20000, false, 50, false),
  ('gestion-commerciale', 'Gestion commerciale', 'Logiciels statistiques et comptables', 400000, '1 mois 1 semaine', 'Gestion des produits, ventes, stocks, clients et opérations commerciales.', 20000, false, 50, false),
  ('marketing-commercial', 'Marketing commercial', 'Logiciels statistiques et comptables', 500000, '1 mois 2 semaines', 'Formation orientée vers la vente, la communication commerciale et le marketing.', 20000, false, 50, false),
  ('photoshop-cs6', 'Photoshop CS6', 'Infographie et multimédia', 400000, '1 mois', 'Montage photo, retouche d’images et création graphique.', 20000, false, 50, false),
  ('filmora-9', 'Filmora 9', 'Infographie et multimédia', 250000, '1 semaine', 'Montage vidéo simple, pratique et accessible aux débutants.', 20000, false, 50, false),
  ('cyberlink-8', 'CyberLink 8', 'Infographie et multimédia', 250000, '1 semaine', 'Outils multimédias pour la création et le traitement de contenus numériques.', 20000, false, 50, false),
  ('anglais-debutant', 'Anglais — Débutant', 'Anglais', 200000, '', 'Parcours d’anglais pour débuter. Durée et horaires à confirmer par le centre.', 20000, false, 50, false),
  ('anglais-intermediaire', 'Anglais — Intermédiaire', 'Anglais', 400000, '', 'Parcours d’anglais de niveau intermédiaire. Durée et horaires à confirmer par le centre.', 20000, false, 50, false),
  ('anglais-avance', 'Anglais — Avancé', 'Anglais', 600000, '', 'Parcours d’anglais de niveau avancé. Durée et horaires à confirmer par le centre.', 20000, false, 50, false),
  ('developpement-personnel', 'Développement personnel', 'Développement personnel', null, '', 'Thèmes indicatifs : confiance en soi, communication interpersonnelle, gestion du temps, objectifs, prise de parole et travail en équipe. Tarif, durée et programme à confirmer.', 20000, false, 50, false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-documents',
  'student-documents',
  false,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read own or staff read all student files" on storage.objects;
create policy "Users read own or staff read all student files" on storage.objects
for select to authenticated using (
  bucket_id = 'student-documents' and
  ((select public.is_staff()) or
   exists (select 1 from public.documents d where d.storage_path = name and d.student_id = (select auth.uid()) and d.visible_to_student = true) or
   exists (select 1 from public.resources r where r.storage_path = name))
);
drop policy if exists "Students upload into own folder" on storage.objects;
create policy "Students upload into own folder" on storage.objects
for insert to authenticated with check (
  bucket_id = 'student-documents' and
  (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "Staff manage student files" on storage.objects;
create policy "Staff manage student files" on storage.objects
for all to authenticated using (
  bucket_id = 'student-documents' and (select public.is_staff())
) with check (
  bucket_id = 'student-documents' and (select public.is_staff())
);
drop policy if exists "Students delete unlinked own uploads" on storage.objects;
create policy "Students delete unlinked own uploads" on storage.objects
for delete to authenticated using (
  bucket_id = 'student-documents' and
  (storage.foldername(name))[1] = (select auth.uid())::text and
  (select public.is_student_upload_unreferenced(name))
);
