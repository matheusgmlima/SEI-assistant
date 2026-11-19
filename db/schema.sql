-- ════════════════════════════════════════════════════════════════════════════
-- SEI Assistant — base central (PostgreSQL 14+)
-- Rodar uma vez quando a TI liberar o banco:  psql -f db/schema.sql
-- Tudo fica dentro da rede do tribunal (os documentos têm dado pessoal — LGPD).
-- ════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS sei_assistant;
SET search_path = sei_assistant;

-- Busca vetorial é opcional: só funciona se a TI instalar a extensão pgvector E liberar
-- um modelo de embedding no LiteLLM (hoje a chave não tem nenhum). Sem ela, a busca usa
-- metadados + texto em português (tsvector), que já resolve "achar o modelo parecido".
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgvector indisponível — busca semântica desativada';
END $$;

-- ── Caixinhas ────────────────────────────────────────────────────────────────
-- Um grupo é a "caixinha": reúne unidades que compartilham modelos (ex.: "BID" =
-- UGP - BID + COORD. AQUISIÇÕES - BID). Por padrão uma unidade só vê o próprio grupo.
CREATE TABLE grupo (
  id          serial PRIMARY KEY,
  nome        text NOT NULL UNIQUE,
  descricao   text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unidade (
  sigla       text PRIMARY KEY,               -- exatamente como o SEI mostra ("UGP - BID")
  grupo_id    int NOT NULL REFERENCES grupo(id)
);

-- Quem pode colocar/aprovar modelos (hoje: uma pessoa centralizando).
CREATE TABLE curador (
  login_sei   text PRIMARY KEY,
  nome        text,
  grupo_id    int REFERENCES grupo(id),       -- NULL = curador de todos os grupos
  ativo       boolean NOT NULL DEFAULT true
);

-- ── Documentos-modelo ───────────────────────────────────────────────────────
CREATE TYPE tipo_documento AS ENUM ('tr', 'etp', 'dfd', 'edital', 'minuta', 'parecer', 'relatorio', 'projeto_basico', 'outro');
-- modelo_oficial = padrão da unidade (manda); exemplo = documento real bom de processo passado (inspira)
CREATE TYPE natureza_modelo AS ENUM ('modelo_oficial', 'exemplo');

CREATE TABLE modelo (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id         int NOT NULL REFERENCES grupo(id),
  tipo             tipo_documento NOT NULL,
  natureza         natureza_modelo NOT NULL,
  titulo           text NOT NULL,
  -- metadados para achar "o modelo que se parece com este processo"
  categoria        text,                       -- bens | servicos | obras | ti | consultoria | outro
  modalidade       text,                       -- pregão, dispensa, adesão a ata, seleção BID…
  fonte_recurso    text,                       -- BID, tesouro…
  palavras_chave   text[] NOT NULL DEFAULT '{}',
  resumo           text,                       -- 2-3 linhas do objeto (gerado na importação)
  -- origem no SEI (todos os modelos vêm de lá)
  processo_sei     text,
  documento_sei    text,                       -- nº SEI do documento
  -- versão: um modelo novo pode substituir o anterior (o antigo fica, mas deixa de ser usado)
  versao           int NOT NULL DEFAULT 1,
  substitui_id     uuid REFERENCES modelo(id),
  vigente          boolean NOT NULL DEFAULT true,
  texto            text NOT NULL,
  tsv              tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('portuguese', coalesce(titulo, '') || ' ' || array_to_string(palavras_chave, ' ')), 'A') ||
                     setweight(to_tsvector('portuguese', coalesce(resumo, '')), 'B') ||
                     setweight(to_tsvector('portuguese', texto), 'D')) STORED,
  criado_por       text REFERENCES curador(login_sei),
  criado_em        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX modelo_busca ON modelo (grupo_id, tipo) WHERE vigente;
CREATE INDEX modelo_tsv ON modelo USING gin (tsv);

-- Cláusulas/seções do modelo, na ordem — permitem "compare com a cláusula 7 do modelo"
-- e gerar o documento novo seção por seção.
CREATE TABLE secao (
  id          bigserial PRIMARY KEY,
  modelo_id   uuid NOT NULL REFERENCES modelo(id) ON DELETE CASCADE,
  ordem       int NOT NULL,
  numero      text,                            -- "5", "5.2", "CLÁUSULA SÉTIMA"
  titulo      text,
  texto       text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(titulo, '') || ' ' || texto)) STORED,
  UNIQUE (modelo_id, ordem)
);
CREATE INDEX secao_tsv ON secao USING gin (tsv);

-- Só cria a coluna de vetor se o pgvector existir (768 = gemini-embedding / text-embedding-005).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE secao ADD COLUMN embedding vector(768);
    CREATE INDEX secao_embedding ON secao USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;

-- Cada documento gerado a partir de um modelo (para saber quais modelos servem e quais não).
CREATE TABLE geracao (
  id           bigserial PRIMARY KEY,
  modelo_id    uuid REFERENCES modelo(id),
  processo_sei text NOT NULL,
  unidade      text,
  login_sei    text,
  aproveitado  boolean,                         -- o usuário disse que o rascunho serviu?
  em           timestamptz NOT NULL DEFAULT now()
);

-- ── Aprendizado dos agentes (a "central" discutida antes) ───────────────────
-- Avaliações dos servidores nas correções ("Já alterei" / "Não é válida" / "Não sei").
CREATE TABLE avaliacao (
  chave        text NOT NULL,                   -- processo|agente|trecho normalizado
  processo_sei text NOT NULL,
  agente       text NOT NULL,
  veredito     text NOT NULL CHECK (veredito IN ('procede', 'falso_positivo', 'incerto')),
  criticidade  text,
  onde         text,
  problema     text,
  trecho       text,
  nota         text,                            -- o "porquê" do servidor
  versao_prompt int,
  unidade      text,
  login_sei    text,
  em           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chave, login_sei)
);

CREATE TABLE falta (
  id           bigserial PRIMARY KEY,
  processo_sei text NOT NULL,
  agente       text NOT NULL,
  texto        text NOT NULL CHECK (length(texto) BETWEEN 3 AND 2000),
  login_sei    text,
  em           timestamptz NOT NULL DEFAULT now()
);

-- Versões dos prompts aprovadas pelo controlador (só cresce: "desfazer" = publicar a antiga de novo).
CREATE TABLE versao_prompt (
  agente       text NOT NULL,
  versao       int NOT NULL,
  prompt       text NOT NULL CHECK (length(prompt) BETWEEN 500 AND 60000),
  motivo       text,
  origem       text,                            -- auto | manual
  placar       jsonb,                           -- resultado do teste de regressão
  publicado_por text,
  em           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agente, versao)
);

-- Uma linha por revisão rodada (custo, achados por agente) — base das estatísticas.
CREATE TABLE revisao (
  id           bigserial PRIMARY KEY,
  processo_sei text NOT NULL,
  unidade      text,
  documentos   int,
  agentes      jsonb NOT NULL,                  -- [{agente, achados, custoUsd, tokens, versao, doCache, erro}]
  em           timestamptz NOT NULL DEFAULT now()
);
