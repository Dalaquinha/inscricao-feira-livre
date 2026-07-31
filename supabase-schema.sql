-- =====================================================================
-- Esquema Supabase — Inscrição Feira Livre de Blumenau
-- Rode este script em: Supabase > SQL Editor > New query
-- =====================================================================

-- ---------- tabela principal ----------
create table if not exists inscricoes (
  id                  uuid primary key default gen_random_uuid(),
  protocolo           text unique not null,
  local               text not null,
  dias                text[] not null,
  nome                text not null,
  cpf                 text not null,
  nascimento          date,
  email               text not null,
  telefone            text not null,
  instagram           text,
  endereco            jsonb not null,           -- {rua, numero, bairro, cep, cidade, uf}
  produtos            text not null,
  origem_produtos     text not null,             -- 'produtor' | 'revenda' | 'misto'
  fornecedores        text,
  producao_propria    text,
  producao_terceiros  text,
  qtd_auxiliares      integer default 0,
  nomes_auxiliares    text,
  lgpd_aceite         boolean not null default false,
  declaracao_aceite   boolean not null default false,
  ip                  text,
  status              text not null default 'Recebida',  -- Recebida | Deferida | Indeferida
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now()
);

create index if not exists idx_inscricoes_cpf on inscricoes (cpf);
create index if not exists idx_inscricoes_protocolo on inscricoes (protocolo);

-- ---------- registro de alteração (atualizado_em automático) ----------
create or replace function set_atualizado_em()
returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_inscricoes_atualizado_em on inscricoes;
create trigger trg_inscricoes_atualizado_em
  before update on inscricoes
  for each row
  execute function set_atualizado_em();

-- ---------- contador atômico de protocolo, por ano ----------
create table if not exists contadores_protocolo (
  ano      integer primary key,
  contador integer not null default 0
);

-- Função chamada pela Netlify Function (via supabase.rpc) para gerar o
-- próximo protocolo do ano de forma atômica (evita duplicidade em envios simultâneos).
create or replace function gerar_protocolo(p_ano integer)
returns text as $$
declare
  v_contador integer;
begin
  insert into contadores_protocolo (ano, contador)
  values (p_ano, 1)
  on conflict (ano) do update set contador = contadores_protocolo.contador + 1
  returning contador into v_contador;

  return 'FEIRA-' || p_ano || '-' || lpad(v_contador::text, 6, '0');
end;
$$ language plpgsql;

-- ---------- Row Level Security ----------
-- A tabela só é acessível pela service role key (usada na Netlify Function).
-- Nenhuma política pública de leitura/escrita é criada aqui de propósito.
alter table inscricoes enable row level security;
alter table contadores_protocolo enable row level security;
