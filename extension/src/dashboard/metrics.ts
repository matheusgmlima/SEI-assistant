/**
 * extension/src/dashboard/metrics.ts
 *
 * Agrega os processos coletados (proc_* do storage) em métricas para o painel
 * analítico da unidade. Funções puras sobre ProcessDetails[].
 */

import type { ProcessDetails, AuditSeverity } from "@shared/index";
import { deriveStatus, parseAuditDate } from "@shared/index";

export interface RiskSlice { key: string; label: string; count: number; color: string; }
export interface BarItem { label: string; count: number; }
export interface GargaloItem { unit: string; mediaDias: number; ocorrencias: number; totalDias: number; }
export interface AtencaoItem {
  id: string;
  type: string | null;
  risk: AuditSeverity | "nao";
  score: number | null;
  statusLabel: string;
  diasParado: number | null;
}

export interface DashMetrics {
  total: number;
  auditados: number;
  scoreMedia: number | null;
  tempoMedioParado: number | null;
  parados30: number;
  parados90: number;
  concluidos: number;
  riskDist: RiskSlice[];
  statusDist: BarItem[];
  tipoDist: BarItem[];
  gargalos: GargaloItem[];
  atencao: AtencaoItem[];
}

const RISK_COLOR: Record<string, string> = {
  critico: "#B91C1C", alto: "#C2410C", medio: "#A16207", baixo: "#16A34A", nao: "#94A3B8",
};
const RISK_LABEL: Record<string, string> = {
  critico: "Crítico", alto: "Alto", medio: "Médio", baixo: "Conforme", nao: "A analisar",
};
const RISK_ORDER = ["critico", "alto", "medio", "baixo", "nao"];

function riskBucket(d: ProcessDetails): string {
  if (!d.audit) return "nao";
  return d.audit.riskLevel === "ok" ? "baixo" : d.audit.riskLevel;
}

/** Normaliza o tipo do processo para agrupamento (corta tamanho, tira sufixos). */
function normalizeType(t: string | null): string {
  if (!t) return "Não classificado";
  return t.trim().replace(/\s+/g, " ").slice(0, 48);
}

export function computeMetrics(list: ProcessDetails[]): DashMetrics {
  const total = list.length;
  const auditados = list.filter((d) => d.audit).length;

  const scores = list.filter((d) => d.audit).map((d) => d.audit!.score);
  const scoreMedia = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  // Status + dias parado
  const statusCount = new Map<string, number>();
  const paradoDias: number[] = [];
  let parados30 = 0, parados90 = 0, concluidos = 0;

  for (const d of list) {
    const st = deriveStatus(d);
    statusCount.set(st.statusLabel, (statusCount.get(st.statusLabel) ?? 0) + 1);
    if (st.concluido) concluidos++;
    if (!st.concluido && st.diasParado !== null) {
      paradoDias.push(st.diasParado);
      if (st.diasParado > 30) parados30++;
      if (st.diasParado > 90) parados90++;
    }
  }
  const tempoMedioParado = paradoDias.length
    ? Math.round(paradoDias.reduce((a, b) => a + b, 0) / paradoDias.length)
    : null;

  // Distribuição de risco
  const riskCount = new Map<string, number>();
  for (const d of list) {
    const b = riskBucket(d);
    riskCount.set(b, (riskCount.get(b) ?? 0) + 1);
  }
  const riskDist: RiskSlice[] = RISK_ORDER
    .map((k) => ({ key: k, label: RISK_LABEL[k], count: riskCount.get(k) ?? 0, color: RISK_COLOR[k] }))
    .filter((s) => s.count > 0);

  // Status dist (ordenado por contagem)
  const statusDist: BarItem[] = [...statusCount.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // Tipos (top 6)
  const tipoCount = new Map<string, number>();
  for (const d of list) {
    const t = normalizeType(d.type);
    tipoCount.set(t, (tipoCount.get(t) ?? 0) + 1);
  }
  const tipoDist: BarItem[] = [...tipoCount.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // Gargalos por unidade: tempo entre movimentações consecutivas atribuído à unidade de origem
  const unitAgg = new Map<string, { total: number; count: number }>();
  for (const d of list) {
    const chrono = [...d.andamento]
      .filter((a) => a.date && a.unit)
      .sort((a, b) => (parseAuditDate(a.date)?.getTime() ?? 0) - (parseAuditDate(b.date)?.getTime() ?? 0));
    for (let i = 0; i < chrono.length - 1; i++) {
      const t0 = parseAuditDate(chrono[i].date), t1 = parseAuditDate(chrono[i + 1].date);
      if (!t0 || !t1) continue;
      const dias = Math.round((t1.getTime() - t0.getTime()) / 86400000);
      if (dias < 0 || dias > 3650) continue; // descarta datas inconsistentes
      const u = chrono[i].unit.trim();
      const cur = unitAgg.get(u) ?? { total: 0, count: 0 };
      cur.total += dias; cur.count += 1;
      unitAgg.set(u, cur);
    }
  }
  const gargalos: GargaloItem[] = [...unitAgg.entries()]
    .map(([unit, { total, count }]) => ({ unit, totalDias: total, ocorrencias: count, mediaDias: Math.round(total / count) }))
    .filter((g) => g.ocorrencias >= 2) // só unidades com histórico significativo
    .sort((a, b) => b.mediaDias - a.mediaDias)
    .slice(0, 6);

  // Processos que precisam de atenção (risco + dias parado)
  const rank: Record<string, number> = { critico: 0, alto: 1, medio: 2, baixo: 3, nao: 4 };
  const atencao: AtencaoItem[] = list
    .map((d) => {
      const st = deriveStatus(d);
      const b = riskBucket(d);
      return {
        id: d.id,
        type: d.type,
        risk: (d.audit ? (d.audit.riskLevel === "ok" ? "baixo" : d.audit.riskLevel) : "nao") as AuditSeverity | "nao",
        score: d.audit?.score ?? null,
        statusLabel: st.statusLabel,
        diasParado: st.concluido ? null : st.diasParado,
        _rank: rank[b] ?? 4,
        _dias: st.concluido ? -1 : (st.diasParado ?? -1),
      };
    })
    .sort((a, b) => (a._rank - b._rank) || (b._dias - a._dias))
    .slice(0, 8)
    .map(({ _rank, _dias, ...rest }) => rest);

  return {
    total, auditados, scoreMedia, tempoMedioParado, parados30, parados90, concluidos,
    riskDist, statusDist, tipoDist, gargalos, atencao,
  };
}
