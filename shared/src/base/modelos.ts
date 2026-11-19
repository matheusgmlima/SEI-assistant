/**
 * Base de modelos por "caixinha" (grupo de unidades) — o lado que não depende de banco.
 * Espelha as tabelas de db/schema.sql. Hoje os modelos ficam no navegador do curador;
 * quando o Postgres do tribunal chegar, só a implementação de `FonteModelos` muda.
 *
 * Busca: metadados (grupo + tipo + categoria) e palavras do objeto. Sem embedding —
 * a chave do LiteLLM não tem modelo de embedding liberado, e para "achar o TR parecido"
 * dentro de uma caixinha com dezenas de modelos isso já basta.
 */

export type TipoDocumento = "tr" | "etp" | "dfd" | "edital" | "minuta" | "parecer" | "relatorio" | "projeto_basico" | "outro";
export type Natureza = "modelo_oficial" | "exemplo";
export type Categoria = "bens" | "servicos" | "obras" | "ti" | "consultoria" | "outro";

export interface Secao { ordem: number; numero: string | null; titulo: string | null; texto: string }

export interface Modelo {
  id: string;
  grupo: string;                 // nome da caixinha
  tipo: TipoDocumento;
  natureza: Natureza;
  titulo: string;
  categoria: Categoria;
  modalidade?: string | null;
  fonteRecurso?: string | null;
  palavrasChave: string[];
  resumo: string;
  processoSei?: string | null;
  documentoSei?: string | null;
  versao: number;
  substituiId?: string | null;
  vigente: boolean;
  texto: string;
  secoes: Secao[];
  criadoPor?: string | null;
  criadoEm: string;
}

/** Onde os modelos moram. Hoje: IndexedDB do curador. Depois: API do banco do tribunal. */
export interface FonteModelos {
  listar(filtro?: { grupo?: string; tipo?: TipoDocumento }): Promise<Modelo[]>;
  salvar(m: Modelo): Promise<void>;
  remover(id: string): Promise<void>;
}

export const ROTULO_TIPO: Record<TipoDocumento, string> = {
  tr: "Termo de Referência", etp: "Estudo Técnico Preliminar", dfd: "DFD", edital: "Edital", minuta: "Minuta de contrato",
  parecer: "Parecer", relatorio: "Relatório", projeto_basico: "Projeto Básico", outro: "Outro",
};
export const ROTULO_CATEGORIA: Record<Categoria, string> = {
  bens: "Bens", servicos: "Serviços", obras: "Obras e engenharia", ti: "Tecnologia da informação", consultoria: "Consultoria", outro: "Outro",
};

// ── Classificação ───────────────────────────────────────────────────────────────
export function tipoPeloTitulo(titulo: string): TipoDocumento {
  const t = titulo.toLowerCase();
  if (/termo de refer|\btr\b/.test(t)) return "tr";
  if (/estudo t[ée]cnico|\betp\b/.test(t)) return "etp";
  if (/\bdfd\b|formaliza[çc][ãa]o d[ae] demanda/.test(t)) return "dfd";
  if (/projeto b[áa]sico/.test(t)) return "projeto_basico";
  if (/edital/.test(t)) return "edital";
  if (/minuta|contrato/.test(t)) return "minuta";
  if (/parecer/.test(t)) return "parecer";
  if (/relat[óo]rio/.test(t)) return "relatorio";
  return "outro";
}

const CATEGORIAS: [Categoria, RegExp][] = [
  ["obras", /\bobras?\b|engenharia|reforma|constru[çc][ãa]o|edifica/],
  ["ti", /software|licen[çc]a|tecnologia da informa|\bti\b|sistema de informa|computador|notebook|servidores? de rede|nuvem/],
  ["consultoria", /consultori|consultor\b|consultora\b/],
  ["servicos", /presta[çc][ãa]o de servi[çc]|servi[çc]os? (de|continuad)/],
  ["bens", /aquisi[çc][ãa]o|fornecimento|materia(l|is)|equipamento|mobili[áa]rio|bens\b/],
];
/** Categoria do objeto pela seção do objeto (ou começo do texto). */
export function categoriaDoTexto(texto: string): Categoria {
  const t = texto.toLowerCase();
  return CATEGORIAS.find(([, re]) => re.test(t))?.[0] ?? "outro";
}

// ── Seções / cláusulas ──────────────────────────────────────────────────────────
// Título de seção: "1. DO OBJETO", "5 - PRAZO DE ENTREGA", "CLÁUSULA SÉTIMA – DAS SANÇÕES",
// "DAS OBRIGAÇÕES DA CONTRATADA". Item longo com ponto final ("5.2. O fornecedor deverá…")
// é conteúdo, não título.
const CLAUSULA = /^(CL[ÁA]USULA\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ\d]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ]+)?)\s*[-–—:.]?\s*(.*)$/;
const NUMERADO = /^(\d{1,2})\s*(?:[.)]|\s-|–|—)?\s+(.{3,100})$/;
const maiusculas = (s: string) => { const l = s.replace(/[^A-Za-zÀ-ÿ]/g, ""); return l.length >= 4 && l === l.toUpperCase(); };

function tituloDeSecao(linha: string): { numero: string | null; titulo: string | null } | null {
  if (/\.{4,}|…{2,}/.test(linha)) return null; // linha de sumário ("10 OBRIGAÇÕES ........ 7")
  const c = linha.match(CLAUSULA);
  if (c) return { numero: c[1].trim(), titulo: c[2].trim() || null };
  const n = linha.match(NUMERADO);
  if (n && !/[.;:]$/.test(n[2]) && (maiusculas(n[2]) || n[2].length <= 60)) return { numero: n[1], titulo: n[2].trim() };
  if (maiusculas(linha) && linha.length <= 90 && linha.split(/\s+/).length >= 2 && /^(D[OA]S?|DE)\s/.test(linha)) return { numero: null, titulo: linha };
  return null;
}

/** Divide o texto do documento por seção/cláusula de primeiro nível. Sem títulos → 1 seção. */
export function secionar(texto: string): Secao[] {
  const secoes: Secao[] = [];
  let atual: Secao = { ordem: 0, numero: null, titulo: "Preâmbulo", texto: "" };
  for (const linha of texto.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const h = tituloDeSecao(linha);
    if (h) {
      if (atual.texto.trim()) secoes.push(atual);
      atual = { ordem: secoes.length, ...h, texto: "" };
    } else atual.texto += (atual.texto ? "\n" : "") + linha;
  }
  if (atual.texto.trim()) secoes.push(atual);
  if (secoes.length <= 1) return [{ ordem: 0, numero: null, titulo: "Documento inteiro", texto: texto.trim() }];
  return secoes.map((s, i) => ({ ...s, ordem: i }));
}

// ── Palavras do objeto (para comparar processo × modelo) ────────────────────────
const VAZIAS = new Set(("a o e de da do das dos em no na nos nas para por com sem que se um uma os as ao aos à às " +
  "ou ser sua seu suas seus como mais pelo pela este esta esse essa objeto contratação aquisição presente termo " +
  "referência item itens conforme demais nº tribunal justiça pernambuco tjpe estado fornecimento prestação serviço serviços " +
  "empresa especializada visando quando sobre entre").split(" "));
export function palavras(texto: string, max = 25): string[] {
  const freq = new Map<string, number>();
  for (const w of texto.toLowerCase().normalize("NFC").match(/[a-zà-ÿ]{4,}/g) ?? []) {
    if (!VAZIAS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/** Trecho do objeto: a seção "objeto" se houver, senão o começo do documento. */
export function textoDoObjeto(secoes: Secao[], texto: string): string {
  const s = secoes.find((x) => /objeto/i.test(x.titulo ?? ""));
  return (s?.texto ?? texto).slice(0, 1500);
}

/** Monta o registro do modelo a partir do documento lido no SEI. */
export function novoModelo(d: { titulo: string; texto: string; grupo: string; natureza: Natureza; tipo?: TipoDocumento;
  processoSei?: string; documentoSei?: string; criadoPor?: string }): Modelo {
  const secoes = secionar(d.texto);
  const objeto = textoDoObjeto(secoes, d.texto);
  return {
    id: crypto.randomUUID(), grupo: d.grupo, tipo: d.tipo ?? tipoPeloTitulo(d.titulo), natureza: d.natureza,
    titulo: d.titulo, categoria: categoriaDoTexto(objeto), palavrasChave: palavras(d.titulo + "\n" + objeto, 15),
    resumo: objeto.replace(/\s+/g, " ").slice(0, 280), processoSei: d.processoSei ?? null, documentoSei: d.documentoSei ?? null,
    versao: 1, vigente: true, texto: d.texto, secoes, criadoPor: d.criadoPor ?? null, criadoEm: new Date().toISOString(),
  };
}

// ── Escolha do modelo para um documento/processo ────────────────────────────────
export interface Escolha { modelo: Modelo; pontos: number; motivo: string }

/** Modelos da caixinha para um alvo, do mais parecido ao menos. Modelo oficial pesa mais que exemplo. */
export function escolherModelos(modelos: Modelo[], alvo: { grupo: string; tipo: TipoDocumento; texto: string }, max = 3): Escolha[] {
  const pAlvo = new Set(palavras(alvo.texto.slice(0, 4000), 30));
  const catAlvo = categoriaDoTexto(alvo.texto.slice(0, 4000));
  return modelos
    .filter((m) => m.vigente && m.grupo === alvo.grupo && m.tipo === alvo.tipo)
    .map((m) => {
      const comuns = m.palavrasChave.filter((w) => pAlvo.has(w));
      const sim = comuns.length / Math.max(1, Math.min(m.palavrasChave.length, pAlvo.size));
      const mesmaCat = m.categoria === catAlvo && catAlvo !== "outro";
      const pontos = sim * 10 + (mesmaCat ? 3 : 0) + (m.natureza === "modelo_oficial" ? 2 : 0);
      const motivo = [m.natureza === "modelo_oficial" ? "modelo oficial" : "exemplo", mesmaCat ? `mesma categoria (${ROTULO_CATEGORIA[catAlvo]})` : "",
        comuns.length ? `em comum: ${comuns.slice(0, 5).join(", ")}` : ""].filter(Boolean).join(" · ");
      return { modelo: m, pontos, motivo };
    })
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, max);
}

// ── Caixinhas: qual grupo uma unidade do SEI usa ────────────────────────────────
export interface Grupo { nome: string; unidades: string[] }
const normUnid = (u: string) => u.toUpperCase().replace(/\s+/g, " ").trim();
/** Sem configuração, cada unidade é a própria caixinha. */
export function grupoDaUnidade(grupos: Grupo[], unidade: string | null | undefined): string | null {
  if (!unidade) return null;
  const u = normUnid(unidade);
  return grupos.find((g) => g.unidades.some((x) => normUnid(x) === u))?.nome ?? u;
}
