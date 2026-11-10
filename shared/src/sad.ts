/**
 * shared/src/sad.ts
 *
 * Mapeia um ProcessDetails para uma linha do "Controle Processual SAD/TJ"
 * (aba Acompanhamento_SAD). Preenche o que é coletável/inferível do SEI e
 * marca os campos manuais que precisam ser perguntados ao usuário.
 *
 * Colunas A–AI da planilha (as editáveis). F e AJ+ são calculadas pela própria
 * planilha — não exportamos valores para elas.
 */

import type { ProcessDetails } from "./types/process";
import { parseAuditDate, deriveStatus } from "./audit";

// ─── Listas de valores válidos (espelham a aba "Listas") ─────────────────────────

export const SAD_LISTS = {
  evento: ["Acréscimo", "Adesão a ARP", "Apostilamento", "Consumo", "Nova contratação", "Prorrogação", "Prorrogação com reajuste", "Prorrogação excepcional", "Prorrogação sem reajuste", "Reajuste de preço", "Reequilíbrio econômico-financeiro", "Repactuação", "Supressão", "Termo aditivo"],
  modalidade: ["A definir", "Concorrência Eletrônica", "Credenciamento", "Dispensa", "Dispensa Eletrônica", "Inexigibilidade", "Inexigibilidade (convênio)", "Pregão Eletrônico", "Pregão Eletrônico (SRP)"],
  status: ["Recebido na SAD", "Em análise preliminar", "Aguardando deliberação da autoridade", "Autorizado", "Tramitação Autorizada", "Em saneamento", "Devolvido ao demandante", "Não autorizado", "Cancelado"],
  pca: ["Ajuste no PCA", "Contratação Continuada", "Dispensada", "Inclusão Superveniente", "Não Previsto", "Parcialmente", "PCA Inicial"],
  unidadeDemandante: ["Administração do Palácio", "Adminstração do FRA", "APMC – Assistência Policial Militar e Civil", "ASCOM – Assessoria de Comunicação Social", "CEJ – Centro de Estudos Judiciários", "Cerimonial da Presidência", "CGJ - Corregedoria Geral da Justiça de Pernambuco", "Coordenadoria da Infância e Juventude", "Coordenadoria Estadual Mulher", "DG - Diretoria de Gestão de Terceirização", "DG - Diretoria de Saúde", "DG – Diretoria-Geral", "DIDOC – Diretoria de Documentação", "DIFIN – Secretaria de Finanças", "ESMAPE – Escola Judicial", "Fórum de Caruaru", "Fórum de Petrolina", "MJ – Memorial de Justiça", "NUPEMEC – Núcleo Permanente de Métodos Consensuais de Solução de Conflitos", "Presidência", "SAD – Secretaria de Administração", "SEPLAN – Secretaria de Planejamento e Gestão Estratégica", "SETIC – Secretaria de Tecnologia da Informação", "SGP – Secretaria de Gestão de Pessoas", "SIOB - Diretoria de Engenharia e Arquitetura", "SIOB - Diretoria de Manutenção", "SIOB - Diretoria de Patrimônio e Suprimentos", "SIOB – Secretaria de Infraestrutura e Obras", "Vara de Execução de Penas Alternativas-VEPA"],
  resultadoFinal: ["Cancelada", "Concluída", "Formalizada", "Em tramitação", "Não autorizada", "Devolvida"],
  formalizacao: ["Ata de Registro de Preços", "Contrato", "Instrumento equivalente", "Nota de empenho", "Ordem de fornecimento", "Ordem de serviço", "Termo aditivo", "Termo de adesão", "Termo de apostilamento", "Termo de Cessão de Uso"],
  unidadeInterna: ["NLCD", "GEPRO", "GPP", "GRRR", "Consultoria Jurídica", "Consolidação"],
  prioridade: ["Normal", "Alta", "Urgente"],
  fase: ["Fase preparatória", "Fase externa", "Contratação formalizada", "Encerrada"],
  servidores: ["ADRIANA", "ALEX", "ANA PAULA", "ARTHUR", "BARTOLOMEU BUENO", "CINTIA", "CLAUDINERY", "CLICIA LEITE", "DANIELLE ARCOVERDE", "DEBORA CUNHA", "DEIVSON", "ELIZABETH", "ERICKA ANGELA", "FELIPE", "FERNANDA", "GABRIELA RAPOSO", "GUSTAVO", "IZABELLA", "JORGE CRESPO", "KARLA BARBOSA", "KELLY", "LIANA", "MARCELA", "MARCELO", "MARCIO", "MARCO", "MARCOS", "MARIA JOSE", "MARLEIDE", "MARY ANNE", "RHAYSSA", "ROGERIO", "ROMULO", "SAULO FILIPE", "SIMONE", "STELA", "VALERIO"],
} as const;

// ─── Definição das colunas exportadas (ordem A→AI) ───────────────────────────────

export interface SadColumn { key: string; letter: string; header: string; calc?: boolean; }

export const SAD_COLUMNS: SadColumn[] = [
  { key: "unidadeDemandante", letter: "A", header: "Unidade Demandante" },
  { key: "processoSei",       letter: "B", header: "Processo SEI" },
  { key: "numContrato",       letter: "C", header: "Nº Contrato / Ata" },
  { key: "evento",            letter: "D", header: "Evento Contratual" },
  { key: "dataVigencia",      letter: "E", header: "Data Final da Vigência" },
  { key: "sinalVigencia",     letter: "F", header: "Sinalização Vigência", calc: true },
  { key: "modalidade",        letter: "G", header: "Modalidade" },
  { key: "contratada",        letter: "H", header: "Contratada" },
  { key: "objeto",            letter: "I", header: "Objeto" },
  { key: "situacaoPca",       letter: "J", header: "Situação no PCA" },
  { key: "codigoPca",         letter: "K", header: "Código PCA" },
  { key: "valorEstimado",     letter: "L", header: "Valor Estimado" },
  { key: "dataRecebSad",      letter: "M", header: "Data Recebimento SAD" },
  { key: "statusAtual",       letter: "N", header: "Status Atual" },
  { key: "responsavelSad",    letter: "O", header: "Responsável SAD" },
  { key: "prioridade",        letter: "P", header: "Prioridade" },
  { key: "observacoes",       letter: "Q", header: "Observações" },
  { key: "faseAtual",         letter: "R", header: "Fase Atual" },
  { key: "unidade1",          letter: "S", header: "Unidade (1)" },
  { key: "entrada1",          letter: "T", header: "Entrada (1)" },
  { key: "servidor1",         letter: "U", header: "Servidor (1)" },
  { key: "saida1",            letter: "V", header: "Saída (1)" },
  { key: "unidade2",          letter: "W", header: "Unidade (2)" },
  { key: "entrada2",          letter: "X", header: "Entrada (2)" },
  { key: "servidor2",         letter: "Y", header: "Servidor (2)" },
  { key: "saida2",            letter: "Z", header: "Saída (2)" },
  { key: "unidade3",          letter: "AA", header: "Unidade (3)" },
  { key: "entrada3",          letter: "AB", header: "Entrada (3)" },
  { key: "servidor3",         letter: "AC", header: "Servidor (3)" },
  { key: "saida3",            letter: "AD", header: "Saída (3)" },
  { key: "processoNlcd",      letter: "AE", header: "Processo NLCD nº" },
  { key: "resultadoFinal",    letter: "AF", header: "Resultado Final" },
  { key: "formalizacao",      letter: "AG", header: "Formalização" },
  { key: "numInstrumento",    letter: "AH", header: "Nº do Instrumento" },
  { key: "dataFormalizacao",  letter: "AI", header: "Data da Formalização" },
];

// Override do usuário: qualquer coluna pode ser editada manualmente e guardada
export type SadOverrides = Record<string, string>;

// Padrões pessoais aplicados automaticamente aos campos manuais vazios
export interface SadDefaults {
  responsavelSad?: string;
  prioridade?: string;
  situacaoPca?: string;
}

export type SadFieldSource = "auto" | "inferido" | "manual" | "vazio";

// Campos obrigatórios (★ na planilha) — usados para marcar "pronto"
export const SAD_REQUIRED = ["unidadeDemandante", "processoSei", "evento", "dataRecebSad", "statusAtual", "responsavelSad", "faseAtual"];

// Campos que devem conter uma data (dd/mm/aaaa)
const SAD_DATE_FIELDS = new Set([
  "dataVigencia", "dataRecebSad", "dataFormalizacao",
  "entrada1", "saida1", "entrada2", "saida2", "entrada3", "saida3",
]);

/** Verifica um campo e retorna um aviso se o valor parece incorreto (ou null). */
export function sadFieldIssue(row: SadRow, key: string): string | null {
  const v = (row.values[key] ?? "").trim();
  if (!v) return null;

  // Campos de data: precisam ter formato de data
  if (SAD_DATE_FIELDS.has(key)) {
    if (!/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) return "não parece uma data (use dd/mm/aaaa)";
    return null;
  }

  // Valor estimado: precisa ser monetário e plausível
  if (key === "valorEstimado") {
    const digits = v.replace(/[^\d]/g, "");
    if (!digits) return "não parece um valor em reais";
    const num = Number(v.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));
    if (!isFinite(num) || num <= 0) return "não parece um valor em reais";
    if (num < 100) return "valor muito baixo — pode ser um nº de processo/contrato";
    return null;
  }

  // Contratada: nome muito curto ou só números é suspeito
  if (key === "contratada") {
    if (/^\d+$/.test(v)) return "parece um número, não um nome de empresa";
    if (v.length < 4) return "nome muito curto — confira";
    return null;
  }

  // Nº de contrato/instrumento: deve conter dígitos
  if ((key === "numContrato" || key === "numInstrumento") && !/\d/.test(v)) {
    return "deveria conter o número";
  }
  return null;
}

/** Lista todos os avisos de validação de uma linha. */
export function validateSadRow(row: SadRow): { key: string; message: string }[] {
  const out: { key: string; message: string }[] = [];
  for (const col of SAD_COLUMNS) {
    if (col.calc) continue;
    const msg = sadFieldIssue(row, col.key);
    if (msg) out.push({ key: col.key, message: msg });
  }
  return out;
}

// Tipo de input e lista de cada campo (para a UI de edição)
export const SAD_FIELD_META: Record<string, { type: "select" | "text" | "area"; list?: readonly string[] }> = {
  unidadeDemandante: { type: "select", list: SAD_LISTS.unidadeDemandante },
  numContrato:       { type: "text" },
  evento:            { type: "select", list: SAD_LISTS.evento },
  dataVigencia:      { type: "text" },
  modalidade:        { type: "select", list: SAD_LISTS.modalidade },
  contratada:        { type: "text" },
  objeto:            { type: "text" },
  situacaoPca:       { type: "select", list: SAD_LISTS.pca },
  codigoPca:         { type: "text" },
  valorEstimado:     { type: "text" },
  dataRecebSad:      { type: "text" },
  statusAtual:       { type: "select", list: SAD_LISTS.status },
  responsavelSad:    { type: "select", list: SAD_LISTS.servidores },
  prioridade:        { type: "select", list: SAD_LISTS.prioridade },
  observacoes:       { type: "area" },
  faseAtual:         { type: "select", list: SAD_LISTS.fase },
  unidade1:          { type: "select", list: SAD_LISTS.unidadeInterna },
  entrada1:          { type: "text" },
  servidor1:         { type: "select", list: SAD_LISTS.servidores },
  saida1:            { type: "text" },
  unidade2:          { type: "select", list: SAD_LISTS.unidadeInterna },
  entrada2:          { type: "text" },
  servidor2:         { type: "select", list: SAD_LISTS.servidores },
  saida2:            { type: "text" },
  unidade3:          { type: "select", list: SAD_LISTS.unidadeInterna },
  entrada3:          { type: "text" },
  servidor3:         { type: "select", list: SAD_LISTS.servidores },
  saida3:            { type: "text" },
  processoNlcd:      { type: "text" },
  resultadoFinal:    { type: "select", list: SAD_LISTS.resultadoFinal },
  formalizacao:      { type: "select", list: SAD_LISTS.formalizacao },
  numInstrumento:    { type: "text" },
  dataFormalizacao:  { type: "text" },
};

export interface SadRow {
  values: Record<string, string>;        // key → valor (já com overrides aplicados)
  sources: Record<string, SadFieldSource>;
  missingRequired: string[];             // campos obrigatórios ainda vazios
}

// ─── Helpers de mapeamento ───────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/** Normaliza nome de unidade do SEI: remove sufixo de código ("-1950000000"),
 *  acentos e pontuação. Os nomes no histórico vêm TRUNCADOS + código
 *  (ex: "CONSULTORIA JURIDI-1200000000"). */
function normUnit(s: string): string {
  return s
    .replace(/[-–]\s*\d{6,}\s*$/, "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Casa um texto com o item mais provável de uma lista (inclusão + truncamento). */
function matchList(value: string | null | undefined, list: readonly string[]): string | null {
  if (!value) return null;
  const v = normUnit(value);
  if (!v) return null;
  // match exato
  for (const item of list) if (normUnit(item) === v) return item;
  // match por inclusão (lista contém o valor ou vice-versa)
  for (const item of list) {
    const n = normUnit(item);
    if (v.includes(n) || n.includes(v)) return item;
  }
  // truncamento do SEI: um prefixo longo do valor aparece no item da lista
  if (v.length >= 8) {
    const prefix = v.slice(0, Math.min(v.length, 15));
    for (const item of list) if (normUnit(item).includes(prefix)) return item;
  }
  return null;
}

// ─── Unidades internas da SAD: aliases dos nomes reais do SEI ─────────────────────
// Regexes tolerantes a TRUNCAMENTO (o SEI corta os nomes: "NUCLEO DE LICITACO-…")
const UNIT_ALIASES: [RegExp, string][] = [
  [/\bnlcd\b|nucleo de licitac/, "NLCD"],
  [/\bgepro\b|gerencia de (elaboracao de )?projet/, "GEPRO"],
  [/\bgpp\b|pesquisa de prec/, "GPP"],
  [/\bgrrr\b/, "GRRR"],
  [/consultoria jurid/, "Consultoria Jurídica"],
  [/consolidac/, "Consolidação"],
];

/** Identifica se a unidade do andamento é uma unidade INTERNA da SAD. */
function matchInternalUnit(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = normUnit(value);
  if (!v) return null;
  for (const [re, unit] of UNIT_ALIASES) if (re.test(v)) return unit;
  for (const item of SAD_LISTS.unidadeInterna) {
    const n = normUnit(item);
    if (v === n || v.startsWith(n) || (v.length >= 6 && n.startsWith(v))) return item;
  }
  return null;
}

/** Casa o "Usuário" do histórico com a lista de servidores da SAD (por 1º nome). */
function matchServidor(user: string | null | undefined): string {
  if (!user) return "";
  const u = normUnit(user).replace(/\./g, " ");
  if (!u) return "";
  for (const s of SAD_LISTS.servidores) {
    const n = normUnit(s);
    if (u === n || u.includes(n)) return s;
    const first = n.split(" ")[0];
    if (first.length >= 4 && (u.split(" ")[0] === first || u.startsWith(first))) return s;
  }
  return "";
}

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Extrai um valor do resumo da IA por rótulo (ex: "Modalidade", "Valor estimado"). */
function fromSummary(summary: string | null, labels: string[]): string | null {
  if (!summary) return null;
  for (const line of summary.split("\n")) {
    const m = line.match(/^[•\-*]\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const label = norm(m[1]);
    if (labels.some((l) => label.includes(norm(l)))) {
      const val = m[2].trim();
      if (val && !/não informado|n\/a|nao informado/i.test(val)) return val;
    }
  }
  return null;
}

function parseValor(raw: string | null): string {
  if (!raw) return "";
  // "R$ 21.843,96" → "21843.96"
  const m = raw.match(/[\d.,]+/);
  if (!m) return "";
  let s = m[0].replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return isNaN(n) ? "" : String(n);
}

// ─── Mapeamento principal ────────────────────────────────────────────────────────

export function mapProcessToSad(details: ProcessDetails, overrides: SadOverrides = {}, defaults: SadDefaults = {}): SadRow {
  const values: Record<string, string> = {};
  const sources: Record<string, SadFieldSource> = {};
  const set = (key: string, val: string, src: SadFieldSource) => { values[key] = val; sources[key] = val ? src : "vazio"; };

  const summary = details.summary ?? null;

  // Andamento cronológico
  const chrono = [...details.andamento]
    .filter((a) => a.date || a.unit)
    .sort((a, b) => (parseAuditDate(a.date)?.getTime() ?? 0) - (parseAuditDate(b.date)?.getTime() ?? 0));
  const status = deriveStatus(details);

  // Conteúdo dos documentos lidos — fonte secundária quando não há resumo da IA
  const content = details.despachosContent ?? "";
  const cMatch = (re: RegExp, g = 1): string | null => {
    const m = content.match(re);
    return m && m[g] ? m[g].trim() : null;
  };

  // B · Processo SEI (AUTO)
  set("processoSei", details.id, "auto");

  // I · Objeto (AUTO → resumo → conteúdo)
  const objeto = details.description
    ?? fromSummary(summary, ["Objeto"])
    ?? cMatch(/objeto[:\s]+(?:é\s+|consiste\s+(?:em|na)\s+)?([^.\n;]{15,180})/i)
    ?? "";
  set("objeto", objeto, details.description ? "auto" : "inferido");

  // A · Unidade Demandante (INFERIDO: origem do processo)
  const origem = chrono[0]?.unit ?? null;
  set("unidadeDemandante", matchList(origem, SAD_LISTS.unidadeDemandante) ?? "", "inferido");

  // G · Modalidade (resumo → conteúdo)
  const modal = fromSummary(summary, ["Modalidade", "Categoria"])
    ?? cMatch(/(preg[ãa]o eletr[ôo]nico|dispensa eletr[ôo]nica|dispensa|inexigibilidade|concorr[êe]ncia eletr[ôo]nica|credenciamento|ata de registro)/i);
  set("modalidade", matchList(modal, SAD_LISTS.modalidade) ?? "", "inferido");

  // H · Contratada (resumo → conteúdo)
  const contr = fromSummary(summary, ["Fornecedor", "Contratado", "Contratada"])
    ?? cMatch(/(?:contratada|fornecedor|empresa vencedora|raz[ãa]o social)[:\s]+([A-ZÀ-Ú][^.\n;,]{3,60})/);
  set("contratada", contr ?? "", "inferido");

  // L · Valor Estimado (resumo → conteúdo)
  const valorRaw = fromSummary(summary, ["Valor estimado", "Valor"])
    ?? cMatch(/valor\s+(?:estimado|global|total|m[áa]ximo|anual)[^R$\d]{0,30}(R?\$?\s*[\d.]+,\d{2})/i);
  set("valorEstimado", parseValor(valorRaw), "inferido");

  // E · Data Final da Vigência (resumo → conteúdo)
  const vig = fromSummary(summary, ["Vigência", "Prazo"])
    ?? cMatch(/vig[êe]ncia[^\d]{0,40}(\d{2}\/\d{2}\/\d{4})/i);
  const vigDate = vig ? vig.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] ?? "" : "";
  set("dataVigencia", vigDate, "inferido");

  // D · Evento Contratual (INFERIDO)
  set("evento", inferEvento(details, summary), "inferido");

  // M · Data Recebimento SAD (INFERIDO: 1ª entrada em unidade SAD/interna)
  const recebSad = chrono.find((a) => /\bSAD\b|secretaria de administra/i.test(a.unit) || matchInternalUnit(a.unit));
  set("dataRecebSad", fmtDate(parseAuditDate(recebSad?.date)), "inferido");

  // N · Status Atual (INFERIDO do andamento)
  set("statusAtual", inferStatus(status.statusLabel, chrono), "inferido");

  // R · Fase Atual (INFERIDO)
  set("faseAtual", inferFase(details), "inferido");

  // Tramitação interna (S/W/AA…) — só unidades internas da SAD, em ordem.
  // Planilha tem 3 blocos; se houver mais passagens, mantém as 3 ÚLTIMAS (mais recentes).
  const fasesInternas = buildInternalPhases(chrono).slice(-3);
  for (let i = 0; i < 3; i++) {
    const p = fasesInternas[i];
    set(`unidade${i + 1}`, p?.unit ?? "", "inferido");
    set(`entrada${i + 1}`, fmtDate(p?.entrada ?? null), "inferido");
    set(`saida${i + 1}`, fmtDate(p?.saida ?? null), "inferido");
    set(`servidor${i + 1}`, p?.servidor ?? "", "inferido");
  }

  // Formalização / Resultado / Instrumento (INFERIDO dos documentos)
  const docsText = details.documents.join(" \n ");
  set("formalizacao", inferFormalizacao(docsText), "inferido");
  set("resultadoFinal", inferResultado(details, status), "inferido");
  set("numInstrumento", inferNumInstrumento(details), "inferido");
  set("numContrato", values.numInstrumento, values.numInstrumento ? "inferido" : "vazio");
  set("processoNlcd", inferNlcd(docsText), "inferido");
  set("dataFormalizacao", "", "vazio");

  // Calculadas pela planilha — exportar vazio
  set("sinalVigencia", "", "vazio");

  // Campos sem inferência automática — começam vazios (preenchíveis pelo usuário)
  for (const k of ["situacaoPca", "codigoPca", "responsavelSad", "prioridade", "observacoes"]) {
    if (!(k in values)) set(k, "", "vazio");
  }

  // Aplica PADRÕES pessoais nos campos manuais ainda vazios (auto-preenchimento)
  for (const [k, v] of Object.entries(defaults)) {
    if (v && !values[k]) { values[k] = v; sources[k] = "manual"; }
  }

  // Aplica overrides do usuário sobre QUALQUER campo (corrige/completa o inferido)
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) continue;
    values[k] = v;
    sources[k] = v ? "manual" : "vazio";
  }

  const missingRequired = SAD_REQUIRED.filter((k) => !values[k]);

  return { values, sources, missingRequired };
}

function inferEvento(details: ProcessDetails, summary: string | null): string {
  const blob = norm([details.type, details.description, summary].filter(Boolean).join(" "));
  if (/prorrog/.test(blob)) return "Prorrogação";
  if (/adesao|adesão/.test(blob)) return "Adesão a ARP";
  if (/aditiv/.test(blob)) return "Termo aditivo";
  if (/reajust/.test(blob)) return "Reajuste de preço";
  if (/reequilibr/.test(blob)) return "Reequilíbrio econômico-financeiro";
  if (/repactua/.test(blob)) return "Repactuação";
  if (/apostila/.test(blob)) return "Apostilamento";
  if (/acrescim/.test(blob)) return "Acréscimo";
  return "Nova contratação";
}

function inferStatus(label: string, chrono: { description: string }[]): string {
  const last = norm(chrono[chrono.length - 1]?.description ?? "");
  if (/autoriz/.test(last)) return "Autorizado";
  if (/devolv/.test(last)) return "Devolvido ao demandante";
  if (/saneament/.test(last)) return "Em saneamento";
  if (/cancel/.test(last)) return "Cancelado";
  if (/conclu|arquiv/.test(norm(label))) return "Autorizado";
  if (/recebid/.test(last)) return "Recebido na SAD";
  return "Em análise preliminar";
}

function inferFase(details: ProcessDetails): string {
  const docs = norm(details.documents.join(" "));
  const st = deriveStatus(details);
  if (st.concluido) return "Encerrada";
  if (/contrato|empenho|ata de registro|ordem de servi/.test(docs)) return "Contratação formalizada";
  if (/edital|pregao|sessao|disputa|publicac|homologa/.test(docs)) return "Fase externa";
  return "Fase preparatória";
}

function inferFormalizacao(docsText: string): string {
  const d = norm(docsText);
  if (/ata de registro/.test(d)) return "Ata de Registro de Preços";
  if (/contrato/.test(d)) return "Contrato";
  if (/ordem de servi/.test(d)) return "Ordem de serviço";
  if (/ordem de forneci/.test(d)) return "Ordem de fornecimento";
  if (/empenho/.test(d)) return "Nota de empenho";
  if (/termo de adesao|adesão/.test(d)) return "Termo de adesão";
  if (/termo aditiv/.test(d)) return "Termo aditivo";
  return "";
}

function inferResultado(details: ProcessDetails, status: { concluido: boolean }): string {
  const docs = norm(details.documents.join(" "));
  if (/contrato|empenho|ata de registro|ordem de/.test(docs)) return "Formalizada";
  if (status.concluido) return "Concluída";
  return "Em tramitação";
}

function inferNumInstrumento(details: ProcessDetails): string {
  // procura "Contrato NNN/AAAA" ou "Ata NNN/AAAA" nos títulos
  for (const t of details.documents) {
    const m = t.match(/(contrato|ata|ordem)\D{0,6}(\d{1,4}\/\d{4})/i);
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
  }
  return "";
}

function inferNlcd(docsText: string): string {
  const m = docsText.match(/(\d{1,4}\/\d{4})\s*-?\s*NLCD|NLCD\s*n?º?\s*(\d{1,4}\/\d{4})/i);
  return m ? (m[1] || m[2] || "") : "";
}

interface InternalPhase { unit: string; entrada: Date | null; saida: Date | null; servidor: string; }

/** Reconstrói as passagens por unidades INTERNAS da SAD (NLCD, GEPRO…) em ordem. */
function buildInternalPhases(chrono: { date: string; unit: string; user?: string }[]): InternalPhase[] {
  const phases: InternalPhase[] = [];
  let current: InternalPhase | null = null;

  for (const e of chrono) {
    const matched = matchInternalUnit(e.unit);
    const d = parseAuditDate(e.date);
    if (matched) {
      if (!current || current.unit !== matched) {
        if (current) current.saida = d;
        current = { unit: matched, entrada: d, saida: null, servidor: matchServidor(e.user) };
        phases.push(current);
      } else if (!current.servidor) {
        // dentro da mesma unidade, captura o servidor da movimentação seguinte
        current.servidor = matchServidor(e.user);
      }
    } else if (current) {
      // saiu de uma unidade interna
      current.saida = d;
      current = null;
    }
  }
  return phases;
}

// ─── Exportação TSV (cola direto no Excel) ───────────────────────────────────────

/** Gera linhas TSV (sem cabeçalho) prontas para colar a partir da coluna A. */
export function rowsToTsv(rows: SadRow[]): string {
  // Célula NUNCA pode conter tab/quebra de linha — quebraria o alinhamento ao colar.
  const cell = (v: unknown) => String(v ?? "").replace(/\t/g, " ").replace(/\r?\n|\r/g, " ").trim();
  return rows
    .map((r) => SAD_COLUMNS.map((c) => cell(r.values[c.key])).join("\t"))
    .join("\n");
}

/** Cabeçalho TSV (para CSV de conferência). */
export function sadHeaderTsv(): string {
  return SAD_COLUMNS.map((c) => c.header).join("\t");
}
