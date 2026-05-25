/**
 * extension/src/content/index.ts
 *
 * Injetado em todas as páginas e iframes do SEI (all_frames: true).
 * Detecta sessão, extrai lista de processos e detalhes de processos abertos.
 */

import type { SessionInfo, SeiProcess, ProcessDetails, AndamentoEntry } from "@shared/index";

// ─── Guard de contexto ─────────────────────────────────────────────────────────
// Após reload da extensão, chrome.runtime.id fica undefined — protege todos os calls

function isContextValid(): boolean {
  try { return !!chrome?.runtime?.id; }
  catch { return false; }
}

function safeStorageSet(data: Record<string, unknown>) {
  if (!isContextValid()) return;
  try { chrome.storage.local.set(data); }
  catch (e) { if (!String(e).includes("context invalidated")) console.error(e); }
}

// ─── Constantes ────────────────────────────────────────────────────────────────

const AUTHENTICATED_ACTIONS = [
  "principal", "arvore_visualizar", "processo_visualizar",
  "documento_visualizar", "controlador_ajax",
  "procedimento_controlar", "procedimento_trabalhar",
];

const SESSION_ANCHOR_SELECTOR = "#divInfraBarraSistema";
const PROCESS_NUMBER_REGEX = /\d{7,8}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

const DETAIL_ACTIONS = [
  "arvore_visualizar",
  "procedimento_trabalhar",
  "processo_visualizar",
  "documento_visualizar",
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getActionFromUrl(url: string): string | null {
  try { return new URL(url).searchParams.get("acao"); }
  catch { return null; }
}

// ─── Detecção de sessão ─────────────────────────────────────────────────────────

function isAuthenticated(): boolean {
  const action = getActionFromUrl(window.location.href);
  const hasAnchor = !!document.querySelector(SESSION_ANCHOR_SELECTOR);
  return hasAnchor || (action !== null && AUTHENTICATED_ACTIONS.includes(action));
}

function extractSessionInfo(): Pick<SessionInfo, "username" | "unit"> {
  const unitEl = document.querySelector("#lnkInfraUnidade, .infraBarraUsuario");
  const unit = unitEl?.textContent?.trim() ?? null;
  const userEl = document.querySelector("#txaInfraUsuario, [id*='Usuario']");
  const username = userEl?.textContent?.trim() ?? null;
  return { username, unit };
}

function notifySessionDetected() {
  const { username, unit } = extractSessionInfo();
  safeStorageSet({ session: { status: "detected", username, unit, detectedAt: Date.now() } });
}

function notifySessionEnded() {
  safeStorageSet({ session: { status: "idle", username: null, unit: null, detectedAt: null } });
}

// ─── Extração: lista de processos ──────────────────────────────────────────────

function isProcessListPage(): boolean {
  return getActionFromUrl(window.location.href) === "procedimento_controlar";
}

function extractProcessList(): SeiProcess[] {
  const tables = document.querySelectorAll<HTMLTableElement>("table.infraTable");
  if (!tables.length) return [];

  const processes: SeiProcess[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr")).slice(1);

    for (const row of rows) {
      const text = row.textContent ?? "";
      const match = text.match(PROCESS_NUMBER_REGEX);
      if (!match) continue;
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);

      const cells = row.querySelectorAll("td");
      let type: string | null = null;
      let description: string | null = null;
      let lastUpdate: string | null = null;
      let assignedTo: string | null = null;

      if (cells.length >= 3) {
        const v = cells[2]?.textContent?.trim() ?? "";
        if (v.length > 2 && !PROCESS_NUMBER_REGEX.test(v)) type = v;
      }
      if (cells.length >= 4) {
        const v = cells[3]?.textContent?.trim() ?? "";
        if (v.length > 2 && !PROCESS_NUMBER_REGEX.test(v)) description = v;
      }
      const dateMatch = text.match(/\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?/);
      if (dateMatch) lastUpdate = dateMatch[0];
      const assignedMatch = text.match(/\(([a-z]{3,10})\)/i);
      if (assignedMatch) assignedTo = assignedMatch[1];

      processes.push({ id, status: "received", tag: null, collectedAt: Date.now(),
        type, description, lastUpdate, assignedTo });
    }
  }

  return processes;
}

function tryCollectAndSave() {
  if (!isProcessListPage()) return;
  const processes = extractProcessList();
  if (processes.length > 0) {
    safeStorageSet({ processes, processesCollectedAt: Date.now() });
    console.log(`[SEI Assistant] ${processes.length} processo(s) coletado(s).`);
  }
}

// ─── Extração: detalhes de um processo aberto ──────────────────────────────────

function getCurrentProcessId(): string | null {
  // 1. Links que contêm o número do processo no texto (topo da árvore SEI)
  const allLinks = document.querySelectorAll("a");
  for (const link of allLinks) {
    const match = (link.textContent ?? "").match(PROCESS_NUMBER_REGEX);
    if (match) return match[0];
  }

  // 2. Qualquer elemento com o número visível
  const allEls = document.querySelectorAll("span, div, td, th, h1, h2, h3, p, label");
  for (const el of allEls) {
    // textContent direto sem filhos para evitar pegar texto de containers grandes
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ");
    const match = text.match(PROCESS_NUMBER_REGEX);
    if (match) return match[0];
  }

  // 3. Fallback total: primeiro número de processo em qualquer lugar no body
  const bodyMatch = (document.body.textContent ?? "").match(PROCESS_NUMBER_REGEX);
  return bodyMatch?.[0] ?? null;
}

function extractDocumentsFromTree(): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  function add(el: Element) {
    // Pega texto direto do elemento sem filhos (ignora badge de unidade)
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const text = direct || el.textContent?.replace(/\s+/g, " ").trim() || "";
    if (
      text.length > 3 &&
      !PROCESS_NUMBER_REGEX.test(text) &&
      !/^(I{1,3}|IV|V?I{0,3})$/.test(text) && // volumes
      !seen.has(text)
    ) {
      seen.add(text);
      results.push(text);
    }
  }

  // Estratégia 1: id^='ancDocumento' — padrão SEI para links de documentos na árvore
  document.querySelectorAll("[id^='ancDocumento']").forEach(add);

  // Estratégia 2: links com id_documento no href (alguns documentos usam href direto)
  document.querySelectorAll("a[href*='id_documento']").forEach(add);

  // Estratégia 3: onclick com referência a documento
  document.querySelectorAll<HTMLAnchorElement>("a[onclick*='documento']").forEach(add);

  // Estratégia 4: fallback por palavras-chave se ainda não temos nada
  if (results.length === 0) {
    const DOC_RE = /despacho|contrato|e-mail|email|ordem|recibo|ofício|publicação|relatório|memorando|certidão|documento|autorização|planilha|justificativa|solicitação|portaria|minuta|cronograma|termo|nota|ata|edital/i;
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      const text = (a.textContent ?? "").trim();
      if (DOC_RE.test(text) && text.length < 150 && !PROCESS_NUMBER_REGEX.test(text)) add(a);
    });
  }

  return results;
}

function extractAndamento(): AndamentoEntry[] {
  const table = document.querySelector<HTMLTableElement>("#tblHistorico");
  if (!table) return [];

  return Array.from(table.querySelectorAll("tr"))
    .slice(1)
    .map((row) => {
      const cells = row.querySelectorAll("td");
      return {
        date: cells[0]?.textContent?.trim() ?? "",
        description: cells[1]?.textContent?.trim() ?? "",
        unit: cells[2]?.textContent?.trim() ?? "",
      };
    })
    .filter((e) => e.date || e.description);
}

function extractProcessHeaderInfo() {
  const result = {
    type: null as string | null,
    description: null as string | null,
    currentUnit: null as string | null,
    parties: [] as string[],
  };

  // Busca em pares label/valor nas tabelas do SEI
  const rows = document.querySelectorAll("tr");
  for (const row of rows) {
    const label = (row.querySelector("th, td:first-child")?.textContent ?? "").toLowerCase();
    const value = row.querySelector("td:last-child, td:nth-child(2)")?.textContent?.trim() ?? "";

    if (!value || value.length < 2) continue;

    if (label.includes("tipo")) result.type = result.type ?? value;
    if (label.includes("especif") || label.includes("descri")) result.description = result.description ?? value;
    if (label.includes("unidade") || label.includes("setor")) result.currentUnit = result.currentUnit ?? value;
    if (label.includes("interessado") || label.includes("parte")) result.parties.push(value);
  }

  return result;
}

let detailDebounce: ReturnType<typeof setTimeout> | null = null;

function tryExtractAndSaveDetails() {
  const action = getActionFromUrl(window.location.href);
  const hasAndamento = !!document.querySelector("#tblHistorico");

  // Só roda em frames relevantes
  if (!hasAndamento && (!action || !DETAIL_ACTIONS.includes(action))) return;

  if (detailDebounce) clearTimeout(detailDebounce);
  detailDebounce = setTimeout(() => {
    const id = getCurrentProcessId();
    if (!id) return;

    const storageKey = `proc_${id}`;

    if (!isContextValid()) return;
    chrome.storage.local.get(storageKey, (result) => {
      if (!isContextValid()) return;
      const existing: Partial<ProcessDetails> = result[storageKey] ?? {};

      const documents = extractDocumentsFromTree();
      const andamento = extractAndamento();
      const header = extractProcessHeaderInfo();

      const hasRichData =
        documents.length > 0 || andamento.length > 0 ||
        header.type || header.description || header.currentUnit;

      // Se não tem dados ricos E já existe entrada completa, não sobrescreve
      if (!hasRichData && existing.extractedAt && (existing.documents?.length ?? 0) > 0) return;

      const updated: ProcessDetails = {
        id,
        type: header.type ?? existing.type ?? null,
        description: header.description ?? existing.description ?? null,
        currentUnit: header.currentUnit ?? existing.currentUnit ?? null,
        parties: header.parties.length > 0 ? header.parties : (existing.parties ?? []),
        documents: documents.length > 0 ? documents : (existing.documents ?? []),
        andamento: andamento.length > 0 ? andamento : (existing.andamento ?? []),
        extractedAt: Date.now(),
        summary: existing.summary ?? null,
      };

      safeStorageSet({ [storageKey]: updated });
      console.log(`[SEI Assistant] Detalhes salvos para processo ${id}`, updated);
    });
  }, 600);
}

// ─── Listener de mensagens da sidebar ──────────────────────────────────────────

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isContextValid()) { sendResponse({ ok: false }); return; }
    if (message.type === "COLLECT_PROCESSES") {
      if (isProcessListPage()) {
        tryCollectAndSave();
        sendResponse({ ok: true, onPage: true });
      } else {
        sendResponse({ ok: false, onPage: false });
      }
    }
    return true;
  });
}

// ─── Observador ─────────────────────────────────────────────────────────────────

let lastKnownAuth = false;

function checkAndNotify() {
  const currentlyAuth = isAuthenticated();

  if (currentlyAuth && !lastKnownAuth) {
    console.log("[SEI Assistant] Sessão detectada.");
    notifySessionDetected();
  }
  if (!currentlyAuth && lastKnownAuth) {
    console.log("[SEI Assistant] Sessão encerrada.");
    notifySessionEnded();
  }

  lastKnownAuth = currentlyAuth;

  if (currentlyAuth) {
    tryCollectAndSave();
    tryExtractAndSaveDetails();
  }
}

function startObserver() {
  checkAndNotify();

  setTimeout(() => {
    if (!isContextValid()) return;
    if (isAuthenticated()) {
      notifySessionDetected();
      tryCollectAndSave();
      tryExtractAndSaveDetails();
    }
  }, 1200);

  const observer = new MutationObserver(() => {
    if (!isContextValid()) { observer.disconnect(); return; }
    checkAndNotify();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", checkAndNotify);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver);
} else {
  startObserver();
}
