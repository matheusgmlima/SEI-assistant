/**
 * extension/src/report/buildReport.ts
 *
 * Monta o HTML do dossiê de um processo (resumo + tramitação + auditoria).
 * Função pura (ProcessDetails → HTML string), usada tanto para impressão/PDF
 * quanto para exportação .doc (Word abre HTML com namespace adequado).
 */

import type { ProcessDetails, AuditResult, AuditSeverity, AndamentoEntry } from "@shared/index";
import { deriveStatus, parseAuditDate, extractImportantDocs, cleanDocTitle } from "@shared/index";

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RISK_LABEL: Record<AuditSeverity, string> = {
  critico: "Risco Crítico", alto: "Risco Alto", medio: "Risco Médio",
  baixo: "Conforme", ok: "Conforme",
};
const SEV_LABEL: Record<AuditSeverity, string> = {
  critico: "Crítico", alto: "Alto", medio: "Médio", baixo: "Baixo", ok: "OK",
};
const CAT_LABEL: Record<string, string> = {
  documental: "Documental", temporal: "Prazos", processual: "Sequência",
  financeiro: "Financeiro", conformidade: "Conformidade",
};

/** Converte o resumo (markdown-ish) em HTML. */
function renderSummaryHtml(summary: string): string {
  const lines = summary.split("\n");
  const out: string[] = [];
  let inList = false;

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (/^[─━_=]{3,}$/.test(line)) { closeList(); continue; }

    if (line.startsWith("**") && line.endsWith("**")) {
      closeList();
      out.push(`<h3 class="sec-sub">${esc(line.replace(/\*\*/g, ""))}</h3>`);
      continue;
    }

    const bullet = line.match(/^([•→\-*])\s+(.*)$/);
    if (bullet) {
      if (!inList) { out.push('<ul class="rep-list">'); inList = true; }
      const rest = bullet[2];
      const label = rest.match(/^([^:]{2,40}):\s*(.+)$/);
      const arrow = bullet[1] === "→";
      const content = label
        ? `<strong>${esc(label[1])}:</strong> ${esc(label[2])}`
        : esc(rest);
      out.push(`<li class="${arrow ? "rep-li-arrow" : ""}">${content}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${esc(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** Tabela de tramitação cronológica. */
function renderTimeline(andamento: AndamentoEntry[]): string {
  if (!andamento.length) return '<p class="rep-empty">Histórico de tramitação não coletado.</p>';

  const chrono = [...andamento]
    .filter((a) => a.date || a.description)
    .sort((a, b) => (parseAuditDate(a.date)?.getTime() ?? 0) - (parseAuditDate(b.date)?.getTime() ?? 0));

  const rows = chrono.map((a) => `
    <tr>
      <td class="rep-td-date">${esc(a.date)}</td>
      <td class="rep-td-unit">${esc(a.unit || "—")}</td>
      <td>${esc(a.description)}</td>
    </tr>`).join("");

  return `
    <table class="rep-table">
      <thead><tr><th>Data/Hora</th><th>Unidade</th><th>Movimentação</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Bloco de auditoria. */
function renderAudit(audit: AuditResult): string {
  const riskCls = `risk-${audit.riskLevel}`;
  const checklist = audit.checklist.map((c) => `
    <li class="chk chk-${c.status}">
      <span class="chk-mark">${c.status === "presente" ? "✓" : "✗"}</span>
      ${esc(c.label)}${c.status === "ausente" && c.critical ? ' <em>(obrigatório)</em>' : ""}
    </li>`).join("");

  const findings = audit.findings.length === 0
    ? '<p class="rep-ok">✓ Nenhuma irregularidade identificada.</p>'
    : audit.findings.map((f) => `
      <div class="finding sev-${f.severity}">
        <div class="finding-head">
          <span class="finding-sev">${SEV_LABEL[f.severity]}</span>
          <span class="finding-cat">${CAT_LABEL[f.category] ?? f.category}</span>
          <strong>${esc(f.title)}</strong>
        </div>
        <p class="finding-desc">${esc(f.description)}</p>
        ${f.recommendation ? `<p class="finding-rec"><strong>Recomendação:</strong> ${esc(f.recommendation)}</p>` : ""}
      </div>`).join("");

  return `
    <div class="audit-head ${riskCls}">
      <div class="audit-score">${audit.score}<small>/100</small></div>
      <div class="audit-risk">${RISK_LABEL[audit.riskLevel]}</div>
    </div>
    <h3 class="sec-sub">Achados (${audit.findings.length})</h3>
    ${findings}
    <h3 class="sec-sub">Checklist documental</h3>
    <ul class="chk-list">${checklist}</ul>`;
}

export interface ReportOptions {
  unitName?: string | null; // unidade do usuário (rodapé/cabeçalho)
}

/** Monta o HTML completo do dossiê (corpo, sem <html> wrapper). */
export function buildReportBody(details: ProcessDetails, opts: ReportOptions = {}): string {
  const status = deriveStatus(details);
  const now = new Date();
  const geradoEm = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const meta: [string, string | null][] = [
    ["Tipo", details.type],
    ["Especificação", details.description],
    ["Unidade atual", status.currentUnit ?? details.currentUnit],
    ["Status", status.statusLabel + (status.diasParado !== null && !status.concluido ? ` (${status.diasParado} dias na fase)` : "")],
    ["Interessados", details.parties.join(", ") || null],
  ];
  const metaRows = meta
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("");

  return `
  <header class="rep-header">
    <div class="rep-brand">
      <div class="rep-brand-title">TRIBUNAL DE JUSTIÇA DE PERNAMBUCO</div>
      <div class="rep-brand-sub">${esc(opts.unitName ?? "Sistema Eletrônico de Informações (SEI)")}</div>
    </div>
    <div class="rep-doc-type">Dossiê de Processo</div>
  </header>

  <h1 class="rep-proc">${esc(details.id)}</h1>
  <p class="rep-gerado">Gerado em ${geradoEm} · SEI Assistant</p>

  <section class="rep-sec">
    <h2 class="sec-title">Identificação</h2>
    <table class="rep-meta"><tbody>${metaRows}</tbody></table>
  </section>

  ${details.summary ? `
  <section class="rep-sec">
    <h2 class="sec-title">Resumo Executivo</h2>
    ${renderSummaryHtml(details.summary)}
  </section>` : ""}

  ${(() => {
    const keyDocs = extractImportantDocs(details.documents);
    if (keyDocs.length === 0) return "";
    const rows = keyDocs.slice(0, 14).map((d) => `
      <tr>
        <td class="rep-kd-cat">${esc(d.category)}</td>
        <td>${esc(cleanDocTitle(d.title) || d.title)}</td>
        <td class="rep-td-date">${d.docId ? "#" + esc(d.docId) : ""}</td>
      </tr>`).join("");
    return `
  <section class="rep-sec">
    <h2 class="sec-title">Documentos-chave</h2>
    <table class="rep-table"><tbody>${rows}</tbody></table>
  </section>`;
  })()}

  ${details.audit ? `
  <section class="rep-sec rep-sec-break">
    <h2 class="sec-title">Auditoria de Conformidade</h2>
    ${renderAudit(details.audit)}
  </section>` : ""}

  <section class="rep-sec rep-sec-break">
    <h2 class="sec-title">Histórico de Tramitação</h2>
    ${renderTimeline(details.andamento)}
  </section>

  <footer class="rep-footer">
    Documento gerado automaticamente pelo SEI Assistant a partir dos dados coletados do SEI/TJPE.
    Confira sempre as informações na fonte oficial.
  </footer>`;
}

/** CSS de impressão/visualização do dossiê. */
export const REPORT_CSS = `
  :root {
    --p: #005B8E; --pd: #003D61; --border: #d8dfeb; --muted: #667; --text: #1a2a45;
    --crit: #B91C1C; --alto: #C2410C; --medio: #A16207; --ok: #16A34A;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Roboto, -apple-system, sans-serif;
    color: var(--text); margin: 0; padding: 32px 40px; line-height: 1.5; font-size: 13px;
  }
  .rep-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid var(--p); padding-bottom: 12px; margin-bottom: 18px;
  }
  .rep-brand-title { font-size: 14px; font-weight: 700; color: var(--pd); letter-spacing: 0.02em; }
  .rep-brand-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .rep-doc-type { font-size: 12px; font-weight: 600; color: var(--p); text-transform: uppercase; letter-spacing: 0.05em; }
  .rep-proc { font-size: 22px; font-weight: 700; color: var(--pd); margin: 0; font-family: ui-monospace, monospace; }
  .rep-gerado { font-size: 11px; color: var(--muted); margin: 2px 0 20px; }
  .rep-sec { margin-bottom: 22px; }
  .sec-title {
    font-size: 14px; font-weight: 700; color: var(--pd); text-transform: uppercase;
    letter-spacing: 0.04em; border-bottom: 1px solid var(--border);
    padding-bottom: 5px; margin: 0 0 12px;
  }
  .sec-sub { font-size: 12px; font-weight: 700; color: var(--p); margin: 14px 0 6px; }
  .rep-meta { width: 100%; border-collapse: collapse; }
  .rep-meta th { text-align: left; width: 140px; color: var(--muted); font-weight: 600; padding: 4px 8px 4px 0; vertical-align: top; font-size: 12px; }
  .rep-meta td { padding: 4px 0; }
  .rep-list { margin: 4px 0; padding-left: 18px; }
  .rep-list li { margin: 3px 0; }
  .rep-li-arrow { list-style: none; margin-left: -14px; }
  .rep-li-arrow::before { content: "→ "; color: var(--p); font-weight: 700; }
  .rep-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .rep-table th { background: #f0f5fa; color: var(--pd); text-align: left; padding: 6px 8px; border: 1px solid var(--border); font-size: 11px; }
  .rep-table td { padding: 5px 8px; border: 1px solid var(--border); vertical-align: top; }
  .rep-td-date { white-space: nowrap; color: var(--muted); font-family: ui-monospace, monospace; font-size: 10.5px; }
  .rep-td-unit { white-space: nowrap; font-weight: 600; }
  .rep-kd-cat { white-space: nowrap; font-weight: 600; color: var(--p); font-size: 11px; }
  .rep-empty, .rep-ok { font-size: 12px; color: var(--muted); }
  .rep-ok { color: var(--ok); font-weight: 600; }
  .audit-head { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 8px; border-left-width: 5px; }
  .audit-head.risk-critico { border-left-color: var(--crit); }
  .audit-head.risk-alto { border-left-color: var(--alto); }
  .audit-head.risk-medio { border-left-color: var(--medio); }
  .audit-head.risk-baixo, .audit-head.risk-ok { border-left-color: var(--ok); }
  .audit-score { font-size: 28px; font-weight: 700; color: var(--pd); }
  .audit-score small { font-size: 13px; color: var(--muted); font-weight: 400; }
  .audit-risk { font-size: 14px; font-weight: 700; }
  .risk-critico .audit-risk { color: var(--crit); }
  .risk-alto .audit-risk { color: var(--alto); }
  .risk-medio .audit-risk { color: var(--medio); }
  .risk-baixo .audit-risk, .risk-ok .audit-risk { color: var(--ok); }
  .finding { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 7px; border-left-width: 4px; }
  .finding.sev-critico { border-left-color: var(--crit); }
  .finding.sev-alto { border-left-color: var(--alto); }
  .finding.sev-medio { border-left-color: var(--medio); }
  .finding.sev-baixo { border-left-color: var(--p); }
  .finding-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .finding-sev { font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 1px 7px; border-radius: 10px; background: #eef2f8; color: var(--pd); }
  .finding-cat { font-size: 9.5px; color: var(--muted); }
  .finding-desc { margin: 3px 0; font-size: 12px; }
  .finding-rec { margin: 3px 0 0; font-size: 11.5px; background: #f0f5fa; padding: 5px 8px; border-radius: 4px; }
  .chk-list { list-style: none; padding: 0; margin: 4px 0; }
  .chk { padding: 3px 0; font-size: 12px; }
  .chk-mark { display: inline-block; width: 16px; font-weight: 700; }
  .chk-presente .chk-mark { color: var(--ok); }
  .chk-ausente { color: var(--muted); }
  .chk-ausente .chk-mark { color: var(--crit); }
  .chk em { color: var(--alto); font-style: normal; font-size: 10px; font-weight: 600; }
  .rep-footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 10px; color: var(--muted); }
  @page { margin: 18mm 14mm; }
  @media print {
    body { padding: 0; }
    .rep-sec-break { page-break-inside: auto; }
    .finding, .rep-table tr { page-break-inside: avoid; }
    .no-print { display: none !important; }
  }
`;
