/**
 * shared/src/audit.ts
 *
 * Lógica de auditoria de conformidade de processos SEI/TJPE.
 * Centraliza checklist documental, achados determinísticos e cálculo de score —
 * usada tanto pelo background (para montar prompt da IA) quanto pela sidebar
 * (para renderizar), garantindo uma única fonte de verdade.
 */

import type { ProcessDetails, AndamentoEntry } from "./types/process";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type AuditSeverity = "critico" | "alto" | "medio" | "baixo" | "ok";

export type AuditCategory =
  | "documental"  // presença/ausência de documentos obrigatórios
  | "temporal"    // prazos, gargalos, processo parado
  | "processual"  // ordem/sequência dos atos
  | "financeiro"  // valores, empenho, limites de modalidade
  | "conformidade"; // legalidade geral, fundamentação

export type AuditSource = "regra" | "ia";

export interface AuditFinding {
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  description: string;
  recommendation: string | null;
  source: AuditSource; // origem: regra determinística ou IA
}

export interface ChecklistItem {
  label: string;
  status: "presente" | "ausente" | "na";
  docRef: string | null;  // título do documento que satisfez a regra
  critical: boolean;      // se a ausência representa risco alto
}

export interface AuditResult {
  processId: string;
  category: ProcessCategory;
  score: number;          // 0-100
  riskLevel: AuditSeverity;
  findings: AuditFinding[];
  checklist: ChecklistItem[];
  aiSummary: string | null;
  generatedAt: number;
}

export type ProcessCategory = "contratacao" | "generico";

// ─── Helpers de data ───────────────────────────────────────────────────────────

export function parseAuditDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
}

function sortAndamento(andamento: AndamentoEntry[]): AndamentoEntry[] {
  return [...andamento]
    .filter((e) => e.date)
    .sort((a, b) => {
      const da = parseAuditDate(a.date)?.getTime() ?? 0;
      const db = parseAuditDate(b.date)?.getTime() ?? 0;
      return da - db; // mais antigo → mais recente
    });
}

// ─── Status derivado (para painel de portfólio) ──────────────────────────────────

export interface ProcessStatusInfo {
  statusLabel: string;
  diasParado: number | null; // dias desde a última movimentação
  concluido: boolean;
  currentUnit: string | null;
}

export function deriveStatus(details: ProcessDetails): ProcessStatusInfo {
  const sorted = sortAndamento(details.andamento);
  const last = sorted[sorted.length - 1];

  if (!last) {
    return {
      statusLabel: details.currentUnit ? "Em tramitação" : "Sem histórico",
      diasParado: null,
      concluido: false,
      currentUnit: details.currentUnit,
    };
  }

  const desc = last.description ?? "";
  const concluido = /conclus|arquiv|encerr/i.test(desc);
  const lastDate = parseAuditDate(last.date);
  const diasParado = lastDate ? daysBetween(lastDate, new Date()) : null;

  let statusLabel: string;
  if (/arquiv/i.test(desc)) statusLabel = "Arquivado";
  else if (concluido) statusLabel = "Concluído";
  else if (/sobrest/i.test(desc)) statusLabel = "Sobrestado";
  else if (/aguard/i.test(desc)) statusLabel = "Aguardando";
  else if (/devolv/i.test(desc)) statusLabel = "Devolvido";
  else statusLabel = "Em tramitação";

  return {
    statusLabel,
    diasParado,
    concluido,
    currentUnit: last.unit || details.currentUnit,
  };
}

// ─── Detecção de categoria ──────────────────────────────────────────────────────

const CONTRATACAO_HINTS =
  /contrat|licita|preg[ãa]o|aquisi|dispensa|inexigib|termo de refer|empenho|ata de registro|\bDFD\b|formaliza[çc][ãa]o de demanda|ades[ãa]o|projeto b[áa]sico|cota[çc][ãa]o|fornecedor/i;

export function detectCategory(details: ProcessDetails): ProcessCategory {
  const haystack = [
    details.type ?? "",
    details.description ?? "",
    ...details.documents,
  ].join(" \n ");
  return CONTRATACAO_HINTS.test(haystack) ? "contratacao" : "generico";
}

// ─── Regras de documento esperado ────────────────────────────────────────────────

interface DocRule {
  label: string;
  re: RegExp;
  critical: boolean;
}

const CONTRATACAO_RULES: DocRule[] = [
  { label: "Documento de Formalização da Demanda (DFD)", re: /\bDFD\b|formaliza[çc][ãa]o d[ae] demanda/i, critical: false },
  { label: "Termo de Referência / Projeto Básico",        re: /termo de refer|projeto b[áa]sico/i, critical: true },
  { label: "Pesquisa / Estimativa de Preços",             re: /pesquisa de pre|estimativa|cota[çc][ãa]o|composi[çc][ãa]o de pre|mapa de pre/i, critical: true },
  { label: "Parecer / Análise Jurídica",                  re: /parecer|jur[íi]dic|assessoria jur|nota t[ée]cnica/i, critical: true },
  { label: "Autorização / Ratificação / Homologação",     re: /autoriza|ratifica|homologa|adjudica/i, critical: true },
  { label: "Nota de Empenho",                             re: /empenho/i, critical: false },
  { label: "Contrato / Instrumento Contratual",           re: /contrato|instrumento contratual|minuta contratual|ordem de servi/i, critical: false },
  { label: "Publicação / Extrato (DOE)",                  re: /publica|extrato|di[áa]rio oficial|\bDOE\b|\bDJE\b/i, critical: false },
];

const GENERICO_RULES: DocRule[] = [
  { label: "Despacho de abertura / instrução", re: /despacho|abertura|instru/i, critical: false },
  { label: "Manifestação / Parecer",           re: /parecer|manifesta|nota t[ée]cnica|informa[çc][ãa]o/i, critical: false },
  { label: "Decisão / Conclusão",              re: /decis[ãa]o|conclus|delibera|homologa/i, critical: false },
];

export function buildChecklist(details: ProcessDetails): ChecklistItem[] {
  const cat = detectCategory(details);
  const rules = cat === "contratacao" ? CONTRATACAO_RULES : GENERICO_RULES;

  return rules.map((rule) => {
    const found = details.documents.find((d) => rule.re.test(d));
    return {
      label: rule.label,
      status: found ? "presente" : "ausente",
      docRef: found ?? null,
      critical: rule.critical,
    };
  });
}

// ─── Achados determinísticos (regras) ────────────────────────────────────────────

export function localFindings(details: ProcessDetails, checklist: ChecklistItem[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const sorted = sortAndamento(details.andamento);
  const lastEntry = sorted[sorted.length - 1];
  const concluido = /conclus|arquiv|encerr/i.test(lastEntry?.description ?? "");

  // 1. Documentos críticos ausentes
  for (const c of checklist) {
    if (c.status === "ausente" && c.critical) {
      findings.push({
        category: "documental",
        severity: "alto",
        title: `Ausência: ${c.label}`,
        description: `Não foi localizado na árvore do processo o documento "${c.label}", normalmente exigido neste tipo de processo. A ausência pode indicar instrução incompleta.`,
        recommendation: `Confirmar se o documento foi juntado; se ausente, providenciar antes de dar prosseguimento.`,
        source: "regra",
      });
    }
  }

  // 2. Processo parado (sem movimentação recente e não concluído)
  if (lastEntry && !concluido) {
    const lastDate = parseAuditDate(lastEntry.date);
    if (lastDate) {
      const days = daysBetween(lastDate, new Date());
      if (days > 30) {
        findings.push({
          category: "temporal",
          severity: days > 90 ? "alto" : "medio",
          title: `Processo parado há ${days} dias`,
          description: `A última movimentação registrada foi em ${lastEntry.date} na unidade ${lastEntry.unit || "não identificada"}, sem novo andamento desde então.`,
          recommendation: "Verificar a pendência na unidade atual e cobrar providências.",
          source: "regra",
        });
      }
    }
  }

  // 3. Gargalo: fase única que consumiu tempo desproporcional
  const gargalo = detectGargalo(sorted);
  if (gargalo && gargalo.days > 60) {
    findings.push({
      category: "temporal",
      severity: gargalo.days > 120 ? "alto" : "medio",
      title: `Gargalo na unidade ${gargalo.unit}`,
      description: `O processo permaneceu ${gargalo.days} dias na unidade ${gargalo.unit} (de ${gargalo.from} a ${gargalo.to}), o maior intervalo da tramitação.`,
      recommendation: "Avaliar a causa da permanência prolongada nesta unidade para otimizar fluxos futuros.",
      source: "regra",
    });
  }

  // 4. Empenho presente mas sem contrato (financeiro)
  const temEmpenho = details.documents.some((d) => /empenho/i.test(d));
  const temContrato = details.documents.some((d) => /contrato|instrumento contratual|ordem de servi/i.test(d));
  if (temEmpenho && !temContrato && detectCategory(details) === "contratacao") {
    findings.push({
      category: "financeiro",
      severity: "medio",
      title: "Empenho sem contrato/instrumento localizado",
      description: "Há nota de empenho na árvore, mas nenhum contrato ou instrumento equivalente foi identificado. A despesa deve estar amparada por instrumento adequado.",
      recommendation: "Verificar se o contrato/ordem de serviço foi formalizado e juntado ao processo.",
      source: "regra",
    });
  }

  return findings;
}

interface Gargalo { unit: string; days: number; from: string; to: string; }

function detectGargalo(sorted: AndamentoEntry[]): Gargalo | null {
  if (sorted.length < 2) return null;
  let best: Gargalo | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = parseAuditDate(sorted[i].date);
    const b = parseAuditDate(sorted[i + 1].date);
    if (!a || !b) continue;
    const days = daysBetween(a, b);
    if (!best || days > best.days) {
      best = { unit: sorted[i].unit || "não identificada", days, from: sorted[i].date, to: sorted[i + 1].date };
    }
  }
  return best;
}

// ─── Cálculo de score e risco ────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<AuditSeverity, number> = {
  critico: 25, alto: 14, medio: 7, baixo: 3, ok: 0,
};

export function computeScore(
  checklist: ChecklistItem[],
  findings: AuditFinding[]
): { score: number; riskLevel: AuditSeverity } {
  let score = 100;

  // Desconto por documento ausente
  for (const c of checklist) {
    if (c.status === "ausente") score -= c.critical ? 10 : 3;
  }

  // Desconto por achado (evita dupla penalização: usa o maior peso por categoria+título)
  const seen = new Set<string>();
  for (const f of findings) {
    const k = `${f.category}|${f.title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    score -= SEVERITY_WEIGHT[f.severity] ?? 0;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const hasCritico = findings.some((f) => f.severity === "critico");
  const hasAlto = findings.some((f) => f.severity === "alto");

  let riskLevel: AuditSeverity;
  if (hasCritico || score < 40) riskLevel = "critico";
  else if (hasAlto || score < 60) riskLevel = "alto";
  else if (score < 80) riskLevel = "medio";
  else riskLevel = "baixo";

  return { score, riskLevel };
}

// ─── Dedup de findings (regra + IA) ──────────────────────────────────────────────

export function mergeFindings(local: AuditFinding[], ai: AuditFinding[]): AuditFinding[] {
  const all = [...local, ...ai];
  const seen = new Set<string>();
  const out: AuditFinding[] = [];
  // Ordena por severidade (crítico primeiro) e mantém estável
  const order: Record<AuditSeverity, number> = { critico: 0, alto: 1, medio: 2, baixo: 3, ok: 4 };
  for (const f of all.sort((a, b) => order[a.severity] - order[b.severity])) {
    const k = `${f.category}|${normalizeTitle(f.title)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\d+/g, "").replace(/[^a-zà-ú\s]/gi, "").replace(/\s+/g, " ").trim();
}
