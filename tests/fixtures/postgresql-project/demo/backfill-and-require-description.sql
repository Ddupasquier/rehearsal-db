update public.widgets set description = 'Reviewed synthetic description' where description is null;
alter table public.widgets alter column description set not null;
