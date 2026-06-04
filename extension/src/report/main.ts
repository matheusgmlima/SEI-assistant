/**
 * extension/src/report/main.ts
 *
 * Página de dossiê: lê ?id da URL, busca o processo no storage (mesclando o
 * andamento completo do IndexedDB), renderiza o dossiê e oferece impressão (PDF)
 * e download em Word (.doc). Empacotada na extensão → scripts passam no CSP.
 */

import type { ProcessDetails, AndamentoEntry, SessionInfo } from "@shared/index";
import { buildReportBody, REPORT_CSS, type ReportOptions } from "./buildReport";
import { getAndamentosByProcesso } from "../db/index";

const params = new URLSearchParams(location.search);
const processId = params.get("id");
const autoPrint = params.get("print") === "1";

const reportEl = document.getElementById("report")!;
const toolbarEl = document.getElementById("toolbar")!;

// Injeta o CSS do dossiê
const style = document.createElement("style");
style.textContent = REPORT_CSS + TOOLBAR_CSS();
document.head.appendChild(style);
document.title = processId ? `Dossiê ${processId}` : "Dossiê — SEI Assistant";

function TOOLBAR_CSS(): string {
  return `
    body { background: #eef1f6; }
    #report { background: #fff; max-width: 820px; margin: 16px auto 40px; padding: 32px 40px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-radius: 6px; }
    #toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; align-items: center;
      background: #003D61; padding: 10px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .tb-title { color: #fff; font-weight: 600; font-size: 13px; margin-right: auto; font-family: "Segoe UI", sans-serif; }
    .tb-btn { font-size: 12px; font-weight: 600; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
    .tb-btn-primary { background: #00A3D9; color: #fff; }
    .tb-btn-primary:hover { background: #0089b8; }
    .tb-btn-ghost { background: rgba(255,255,255,0.14); color: #fff; }
    .tb-btn-ghost:hover { background: rgba(255,255,255,0.24); }
    @media print { #report { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
  `;
}

function getSessionUnit(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get("session", (r) => {
      const s = r.session as SessionInfo | undefined;
      resolve(s?.unit ?? null);
    });
  });
}

function getDetails(id: string): Promise<ProcessDetails | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(`proc_${id}`, (r) => resolve((r[`proc_${id}`] as ProcessDetails) ?? null));
  });
}

async function mergeFullAndamento(details: ProcessDetails): Promise<ProcessDetails> {
  try {
    const rows = await getAndamentosByProcesso(details.id);
    const dbAnd: AndamentoEntry[] = rows.map((r) => ({ date: r.data, unit: r.unidade, description: r.descricao }));
    const seen = new Set(details.andamento.map((e) => `${e.date}|${e.unit}|${e.description}`));
    const extra = dbAnd.filter((e) => !seen.has(`${e.date}|${e.unit}|${e.description}`));
    return { ...details, andamento: [...details.andamento, ...extra] };
  } catch {
    return details;
  }
}

function downloadDoc(id: string, bodyHtml: string) {
  // Word abre HTML como .doc se vier com o cabeçalho/namespace adequado
  const html = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Dossiê ${id}</title><style>${REPORT_CSS}</style></head>
<body>${bodyHtml}</body></html>`;
  const blob = new Blob(["﻿", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Dossie_${id.replace(/[^\w.-]/g, "_")}.doc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderToolbar(id: string, bodyHtml: string) {
  toolbarEl.innerHTML = `
    <span class="tb-title">Dossiê · ${id}</span>
    <button class="tb-btn tb-btn-ghost" id="btn-doc">⬇ Baixar Word (.doc)</button>
    <button class="tb-btn tb-btn-primary" id="btn-print">🖨 Imprimir / Salvar PDF</button>`;
  document.getElementById("btn-print")!.addEventListener("click", () => window.print());
  document.getElementById("btn-doc")!.addEventListener("click", () => downloadDoc(id, bodyHtml));
}

async function init() {
  if (!processId) {
    reportEl.innerHTML = '<p style="padding:24px;color:#900">Processo não informado na URL.</p>';
    return;
  }

  const raw = await getDetails(processId);
  if (!raw) {
    reportEl.innerHTML = `<p style="padding:24px;color:#900">Dados do processo ${processId} não encontrados. Colete o processo no SEI Assistant primeiro.</p>`;
    return;
  }

  const [details, unitName] = await Promise.all([mergeFullAndamento(raw), getSessionUnit()]);
  const opts: ReportOptions = { unitName };
  const bodyHtml = buildReportBody(details, opts);

  reportEl.innerHTML = bodyHtml;
  renderToolbar(processId, bodyHtml);

  if (autoPrint) {
    // Aguarda layout assentar antes de abrir o diálogo de impressão
    setTimeout(() => window.print(), 600);
  }
}

init();
