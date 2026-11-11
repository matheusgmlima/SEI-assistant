/**
 * extension/src/content/index.ts
 *
 * Injetado em todas as páginas e iframes do SEI (all_frames: true).
 * Detecta sessão, extrai lista de processos e detalhes de processos abertos.
 */

import type { SessionInfo, SeiProcess, ProcessDetails, AndamentoEntry, CollectionQueueState } from "@shared/index";
import { extractImportantDocs } from "@shared/index";
import { parseArvore, ehLinkDeLeitura, htmlParaTexto, type DocArvore } from "@shared/agents/sei-docs";

// ─── Guard de contexto ─────────────────────────────────────────────────────────
// Após reload da extensão, chrome.runtime.id fica undefined — protege todos os calls

function isContextValid(): boolean {
  try { return !!chrome?.runtime?.id; }
  catch { return false; }
}

// Rede de segurança: quando a extensão é recarregada/atualizada, o content script
// antigo (órfão) na aba do SEI pode lançar "Extension context invalidated" a partir
// de listeners/observers já agendados. Esse erro é sempre benigno — silenciamos
// APENAS ele para não poluir o console (um F5 na aba já recarrega o script novo).
const isCtxInvalidated = (msg: unknown) =>
  typeof msg === "string" && /Extension context invalidated|context invalidated/i.test(msg);

window.addEventListener("error", (e) => {
  if (isCtxInvalidated(e.message) || isCtxInvalidated(String(e.error))) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

window.addEventListener("unhandledrejection", (e) => {
  if (isCtxInvalidated(String(e.reason)) || isCtxInvalidated((e.reason as { message?: string })?.message)) {
    e.preventDefault();
  }
});

function safeStorageSet(data: Record<string, unknown>) {
  if (!isContextValid()) return;
  try { chrome.storage.local.set(data); }
  catch (e) { if (!String(e).includes("context invalidated")) console.error(e); }
}

function safeStorageRemove(key: string) {
  if (!isContextValid()) return;
  try { chrome.storage.local.remove(key); } catch { /* contexto invalidado */ }
}

/** Wrapper Promise-based para chrome.storage.local.get com tipagem estável.
 *  Resiliente à invalidação de contexto (resolve {} em vez de lançar). */
function storageGet(key: string | string[] | null): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (!isContextValid()) { resolve({}); return; }
    try {
      chrome.storage.local.get(key as string, (r) => {
        // lastError precisa ser lido para o Chrome não logar warning
        if (chrome.runtime.lastError) { resolve({}); return; }
        resolve((r as Record<string, unknown>) ?? {});
      });
    } catch { resolve({}); }
  });
}

/** Envia mensagem ao background protegendo contra contexto invalidado. */
function safeSendMessage(message: unknown) {
  if (!isContextValid()) return;
  try {
    chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
  } catch { /* contexto invalidado */ }
}

/**
 * Clica num elemento neutralizando href="javascript:..." para não disparar a
 * navegação por JavaScript URL, que a CSP do SEI bloqueia (poluindo o console).
 * A ação real dos links do SEI está no onclick; o href é só placeholder.
 */
function safeClick(el: Element | null | undefined): void {
  if (!el) return;
  const a = el as HTMLAnchorElement;
  const href = typeof a.getAttribute === "function" ? a.getAttribute("href") : null;
  if (href && /^\s*javascript:/i.test(href)) {
    a.removeAttribute("href");
    try { (el as HTMLElement).click(); } finally { a.setAttribute("href", href); }
  } else {
    (el as HTMLElement).click();
  }
}

// ─── Constantes ────────────────────────────────────────────────────────────────

const AUTHENTICATED_ACTIONS = [
  "principal", "arvore_visualizar", "processo_visualizar",
  "documento_visualizar", "controlador_ajax",
  "procedimento_controlar", "procedimento_trabalhar", "procedimento_visualizar",
];

const SESSION_ANCHOR_SELECTOR = "#divInfraBarraSistema";
const PROCESS_NUMBER_REGEX = /\d{7,8}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

const DETAIL_ACTIONS = [
  "arvore_visualizar",
  "procedimento_trabalhar",
  "processo_visualizar",
  "procedimento_visualizar", // frame real que contém a árvore no SEI/TJPE
  "documento_visualizar",
  // Páginas de histórico/andamento (Consultar Andamento)
  "historico_processo_exibir",
  "procedimento_historico",
  "historico_exibir",
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

const isTopFrame = window === window.top;

function notifySessionDetected() {
  if (!isTopFrame) return; // sub-frames não gerenciam sessão
  const { username, unit } = extractSessionInfo();
  safeStorageSet({ session: { status: "detected", username, unit, detectedAt: Date.now() } });
}

function notifySessionEnded() {
  if (!isTopFrame) return; // sub-frames não gerenciam sessão
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

function extractDocumentsFromTree(): { titles: string[]; links: Record<string, string> } {
  const seen = new Set<string>();       // dedup por texto completo
  const seenDocIds = new Set<string>(); // dedup por id_documento numérico
  const titles: string[] = [];
  const links: Record<string, string> = {};

  function captureLink(text: string, anchor: HTMLAnchorElement | null) {
    if (!anchor) return;
    const href = anchor.href ?? "";
    if (href.includes("id_documento")) {
      links[text] = href;
      // Registra o id_documento para evitar duplicata posterior
      const m = href.match(/id_documento=(\d+)/);
      if (m) seenDocIds.add(m[1]);
    } else {
      const onclick = anchor.getAttribute("onclick") ?? "";
      const match = onclick.match(/controlador\.php[^'")\s]+/);
      if (match) {
        const raw = match[0];
        links[text] = raw.startsWith("http") ? raw : `${window.location.origin}/sei/${raw}`;
      }
    }
  }

  function addWithText(text: string, el: Element) {
    if (
      text.length > 3 &&
      !PROCESS_NUMBER_REGEX.test(text) &&
      !/^(I{1,3}|IV|V?I{0,3})$/.test(text) &&
      !/^Aguarde/i.test(text) &&
      !seen.has(text)
    ) {
      // Dedup por docId numérico (5-8 dígitos) — evita "Despacho 1234" e "Despacho 1234 UNIDADE" duplicados
      const docIdMatch = text.match(/\b(\d{5,8})\b/);
      if (docIdMatch) {
        const docId = docIdMatch[1];
        if (seenDocIds.has(docId)) {
          // Já existe — substitui se o novo tem mais informação (texto mais longo)
          const existingIdx = titles.findIndex((t) => t.includes(docId));
          if (existingIdx >= 0 && text.length > titles[existingIdx].length) {
            seen.delete(titles[existingIdx]);
            titles[existingIdx] = text;
            seen.add(text);
            const anchor = (el.tagName === "A" ? el : el.querySelector("a")) as HTMLAnchorElement | null;
            captureLink(text, anchor);
          }
          return;
        }
        seenDocIds.add(docId);
      }

      seen.add(text);
      titles.push(text);
      const anchor = (el.tagName === "A" ? el : el.querySelector("a")) as HTMLAnchorElement | null;
      captureLink(text, anchor);
    }
  }

  function add(el: Element, useFullText = false) {
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ").replace(/\s+/g, " ").trim();
    const full = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    addWithText(useFullText ? (full || direct) : (direct || full), el);
  }

  const isTreeFrame = getActionFromUrl(window.location.href) === "arvore_visualizar" ||
    document.querySelectorAll(".infraArvoreNo").length > 0;

  // Nós da árvore: textContent + badge de unidade de elementos irmãos
  document.querySelectorAll(".infraArvoreNo").forEach((el) => {
    let text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const parent = el.parentElement;
    if (parent) {
      for (const sib of parent.children) {
        if (sib === el) continue;
        const sibText = sib.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (sibText.length > 0 && sibText.length < 40 && !text.includes(sibText)) {
          text = `${text} ${sibText}`;
          break;
        }
      }
    }

    addWithText(text, el);
  });

  // Links diretos — pula se o id_documento já foi capturado via .infraArvoreNo
  document.querySelectorAll<HTMLAnchorElement>("a[href*='id_documento']").forEach((el) => {
    const idMatch = el.href.match(/id_documento=(\d+)/);
    if (idMatch && seenDocIds.has(idMatch[1])) return; // já capturado com badge
    if (el.closest(".infraArvoreNo")) return;
    add(el, false);
  });
  document.querySelectorAll<HTMLAnchorElement>("a[onclick*='documento']").forEach((el) => {
    if (el.closest(".infraArvoreNo")) return;
    add(el, false);
  });

  if (titles.length === 0 && isTreeFrame) {
    const DOC_RE = /despacho|contrato|e-mail|email|ordem|recibo|ofício|publicação|relatório|memorando|certidão|documento|autorização|planilha|justificativa|solicitação|portaria|minuta|cronograma|termo|nota|ata|edital/i;
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      const text = (a.textContent ?? "").trim();
      if (DOC_RE.test(text) && text.length < 150 && !PROCESS_NUMBER_REGEX.test(text)) add(a, false);
    });
  }

  return { titles, links };
}

function getHistoricoDoc(): Document {
  // Estrutura SEI/TJPE: ifrConteudoVisualizacao > ifrVisualizacao > tblHistorico
  // Tenta acessar o document filho (mesmo domínio, acesso direto permitido)
  try {
    const outer = document.querySelector<HTMLIFrameElement>("#ifrConteudoVisualizacao");
    const inner = (outer?.contentDocument ?? document).querySelector<HTMLIFrameElement>("#ifrVisualizacao");
    if (inner?.contentDocument) return inner.contentDocument;
    if (outer?.contentDocument) return outer.contentDocument;
  } catch { /* cross-origin bloqueado */ }
  return document;
}

function extractAndamento(): AndamentoEntry[] {
  const searchDocs = [document, getHistoricoDoc()].filter((d, i, arr) =>
    arr.indexOf(d) === i // dedup
  );

  let table: HTMLTableElement | null = null;

  for (const doc of searchDocs) {
    // 1. Seletor específico (padrão SEI/TJPE confirmado pelo bot Selenium)
    table = doc.querySelector("#tblHistorico") ??
      doc.querySelector("table[id*='historico']") ??
      doc.querySelector("table[id*='Historico']");

    // 2. Qualquer tabela cujo cabeçalho contenha "Data" + "Unidade"
    if (!table) {
      for (const t of doc.querySelectorAll<HTMLTableElement>("table")) {
        const thEls   = Array.from(t.querySelectorAll("th"));
        const firstTd = Array.from(t.querySelectorAll("tr:first-child td"));
        const candidates = thEls.length > 0 ? thEls : firstTd;
        const texts = candidates.map((c) => c.textContent?.toLowerCase() ?? "");
        if (texts.some((h) => h.includes("data")) && texts.some((h) => h.includes("unidade"))) {
          table = t; break;
        }
      }
    }

    if (table) break;
  }

  if (!table) return [];

  // Detecta colunas pelo cabeçalho (th ou primeira linha td)
  const thEls    = Array.from(table.querySelectorAll("th"));
  const headerEls = thEls.length > 0
    ? thEls
    : Array.from(table.querySelectorAll("tr:first-child td"));
  const headers   = headerEls.map((el) => el.textContent?.replace(/\s+/g, " ").toLowerCase().trim() ?? "");

  const dateIdx = headers.findIndex((h) => h.includes("data"));
  const unitIdx = headers.findIndex((h) => h.includes("unidade") || h.includes("setor"));
  const userIdx = headers.findIndex((h) => h.includes("usu"));
  const descIdx = headers.findIndex((h) => h.includes("descri") || h.includes("movimento") || h.includes("ocorrência"));

  // Fallback: formato TJPE padrão — 0=Data/Hora, 1=Unidade, 2=Usuário, 3=Descrição
  const di = dateIdx >= 0 ? dateIdx : 0;
  const ui = unitIdx >= 0 ? unitIdx : 1;
  const si = userIdx >= 0 ? userIdx : (headers.length >= 4 ? 2 : -1);
  const xi = descIdx >= 0 ? descIdx : (headers.length >= 4 ? 3 : 1);

  // Pula primeira linha (sempre é cabeçalho, independente de th ou td)
  const rows = Array.from(table.querySelectorAll("tr")).slice(1);

  const result: AndamentoEntry[] = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) continue;
    const date        = cells[di]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const unit        = cells[ui]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const user        = si >= 0 ? (cells[si]?.textContent?.replace(/\s+/g, " ").trim() ?? "") : "";
    const description = cells[xi]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (date || description) result.push({ date, unit, description, ...(user ? { user } : {}) });
  }

  console.log(`[SEI Assistant] Andamento extraído: ${result.length} registros`);
  return result;
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

// Guarda processos já expandidos nesta sessão — evita loop infinito
const autoExpandedProcesses = new Set<string>();

// ─── Auto-clique em "Consultar Andamento" ─────────────────────────────────────
// Simula o clique do usuário para abrir o histórico automaticamente.
// Seguro: usa .click() no DOM, não faz fetch HTTP, não invalida sessão.

const autoAndamentoOpened = new Set<string>();

function findAndamentoButton(): HTMLElement | null {
  // Busca em TODOS os frames acessíveis (a toolbar fica em iframes aninhados no TJPE)
  const docs = getAllAccessibleDocs();

  const SELECTORS = [
    'a[href*="historico_processo_exibir"]',
    'a[onclick*="historico_processo_exibir"]',
    'a[href*="procedimento_historico"]',
    'a[onclick*="procedimento_historico"]',
    'img[alt*="Consultar Andamento"]',
    'img[title*="Consultar Andamento"]',
    'a[title*="Consultar Andamento"]',
    'a[title*="Histórico do Processo"]',
    'img[alt*="Hist"]',
    'img[title*="Hist"]',
  ];

  for (const doc of docs) {
    try {
      // 1. Seletores diretos
      for (const sel of SELECTORS) {
        const el = doc.querySelector<HTMLElement>(sel);
        if (el) return el.tagName === "A" ? el : (el.closest("a") as HTMLElement | null) ?? el;
      }

      // 2. Qualquer link/img cujo texto/title/alt/onclick contenha "andamento" ou "histórico"
      const RE = /consultar\s*andamento|hist[oó]rico\s*do\s*processo|andamento\s*do\s*processo/i;
      for (const a of doc.querySelectorAll<HTMLAnchorElement>("a")) {
        const blob = [a.textContent, a.getAttribute("title"), a.getAttribute("href"), a.getAttribute("onclick")].join(" ");
        if (RE.test(blob)) return a;
      }
      for (const img of doc.querySelectorAll<HTMLImageElement>("img")) {
        const blob = [img.getAttribute("alt"), img.getAttribute("title"), img.getAttribute("onclick")].join(" ");
        if (RE.test(blob)) return (img.closest("a") as HTMLElement | null) ?? img;
      }
    } catch { /* frame inacessível */ }
  }

  return null;
}

/** Tenta achar o botão de andamento com algumas tentativas (toolbar pode demorar a carregar). */
async function findAndamentoButtonWithRetry(processId: string, attempts = 6, gapMs = 1000): Promise<HTMLElement | null> {
  for (let i = 0; i < attempts; i++) {
    const btn = findAndamentoButton();
    if (btn) return btn;
    if (await sleepCancellable(gapMs, processId)) return null;
  }
  return null;
}

function tryAutoOpenAndamento(processId: string) {
  if (!isTopFrame) return;                          // só no frame principal
  if (autoAndamentoOpened.has(processId)) return;   // já abriu nesta sessão

  const action = getActionFromUrl(window.location.href);
  if (!["procedimento_trabalhar", "arvore_visualizar", "procedimento_visualizar"].includes(action ?? "")) return;

  // Só abre se ainda não temos andamento salvo
  chrome.storage.local.get(`proc_${processId}`, (result) => {
    if (!isContextValid()) return;
    const existing = result[`proc_${processId}`] as { andamento?: unknown[] } | undefined;
    if ((existing?.andamento?.length ?? 0) > 0) return; // já tem dados

    // Aguarda 1.5s para garantir que a toolbar do SEI carregou
    setTimeout(() => {
      if (!isContextValid()) return;
      const btn = findAndamentoButton();
      if (btn) {
        autoAndamentoOpened.add(processId);
        console.log(`[SEI Assistant] Auto-abrindo "Consultar Andamento" para ${processId}`);
        try { safeClick(btn); } catch (e) { console.warn("[SEI Assistant] Clique falhou:", e); }
      } else {
        console.log(`[SEI Assistant] Botão "Consultar Andamento" não encontrado para ${processId}`);
      }
    }, 1500);
  });
}

// ─── Auto-expand pastas da árvore ─────────────────────────────────────────────
// Clica em todos os nós colapsados para revelar os documentos.
// Busca em TODOS os frames acessíveis (same-origin).
function tryAutoExpandTree(): number {
  let expanded = 0;

  for (const doc of getAllAccessibleDocs()) {
    try {
      // Estratégia 1: imagens de "expandir/mais" dentro de âncoras
      doc.querySelectorAll<HTMLImageElement>(
        'img[src*="mais"], img[src*="expandir"], img[src*="img_mais"], img[alt="+"], img[title*="Expandir"]'
      ).forEach((img) => {
        const a = img.closest<HTMLAnchorElement>("a");
        if (a) { try { safeClick(a); expanded++; } catch { /* ignora */ } }
      });

      // Estratégia 2: links com onclick de expansão da InfraArvore
      doc.querySelectorAll<HTMLAnchorElement>(
        'a[onclick*="Abrir"], a[onclick*="abrir"], a[onclick*="expand"], a[onclick*="Expand"], a[onclick*="infraArvore"]'
      ).forEach((a) => {
        const parent = a.closest("span, div, li");
        const sibling = parent?.nextElementSibling as HTMLElement | null;
        const isCollapsed = !sibling || sibling.style?.display === "none" || sibling.childElementCount === 0;
        if (isCollapsed) { try { safeClick(a); expanded++; } catch { /* ignora */ } }
      });

      // Estratégia 3: ícones de pasta colapsada pelo src (padrão TJPE)
      doc.querySelectorAll<HTMLImageElement>(
        'img[src*="pasta_fechada"], img[src*="folder_closed"], img[src*="collapsed"]'
      ).forEach((img) => {
        const a = img.closest<HTMLAnchorElement>("a");
        if (a) { try { safeClick(a); expanded++; } catch { /* ignora */ } }
      });

      // Estratégia 4: elementos da InfraArvore com estado colapsado
      doc.querySelectorAll<HTMLElement>("[id*='divInfra'][style*='display: none'], [id*='divInfra'][style*='display:none']")
        .forEach((el) => {
          const parentId = el.id.replace("divInfra", "");
          const trigger = doc.querySelector<HTMLElement>(`a[onclick*="${parentId}"], a[href*="${parentId}"]`);
          if (trigger) { try { safeClick(trigger); expanded++; } catch { /* ignora */ } }
        });
    } catch { /* frame inacessível */ }
  }

  if (expanded > 0) console.log(`[SEI Assistant] Auto-expandiu ${expanded} nó(s) da árvore`);
  return expanded;
}

// Poll para árvore SEI carregada via AJAX — só usado quando nós não existem ainda
// Reduzido para 5 tentativas: no TJPE o frame arvore_visualizar é wrapper vazio
let treePoller: ReturnType<typeof setInterval> | null = null;
let treePollerAttempts = 0;
const TREE_POLL_MAX = 5;

function startTreePoller(processId: string) {
  if (treePoller) return; // já rodando
  treePoller = setInterval(() => {
    if (!isContextValid()) { clearInterval(treePoller!); treePoller = null; return; }
    treePollerAttempts++;
    const docs = document.querySelectorAll(".infraArvoreNo").length;
    if (docs > 0 || treePollerAttempts >= TREE_POLL_MAX) {
      clearInterval(treePoller!);
      treePoller = null;
      treePollerAttempts = 0;
      if (docs > 0) {
        doExtractAndSave(processId);
        tryAutoOpenAndamento(processId);
        if (!autoExpandedProcesses.has(processId)) {
          autoExpandedProcesses.add(processId);
          const expanded = tryAutoExpandTree();
          if (expanded > 0) {
            setTimeout(() => { if (isContextValid()) doExtractAndSave(processId); }, 2500);
          }
        }
      }
    }
  }, 1000);
}

/** Encontra o link "Próxima Página" na tabela de histórico (doc atual ou iframe filho) */
function findNextPageLink(): HTMLAnchorElement | null {
  const SELECTOR = '#lnkInfraProximaPaginaSuperior, a[id*="ProximaPagina"], a[id*="proximaPagina"]';
  const direct = document.querySelector<HTMLAnchorElement>(SELECTOR);
  if (direct) return direct;
  try {
    return getHistoricoDoc().querySelector<HTMLAnchorElement>(SELECTOR);
  } catch { return null; }
}

function doExtractAndSave(id: string) {
  if (!isContextValid()) return;
  const storageKey = `proc_${id}`;
  const onHistorico = isHistoricoPage();

  chrome.storage.local.get(storageKey, (result) => {
    if (!isContextValid()) return;
    const existing: Partial<ProcessDetails> = result[storageKey] ?? {};

    const { titles: documents, links: docLinks } = extractDocumentsFromTree();
    const andamento = extractAndamento();
    const header = extractProcessHeaderInfo();

    const hasRichData =
      documents.length > 0 || andamento.length > 0 ||
      header.type || header.description || header.currentUnit;

    if (!hasRichData && existing.extractedAt && (existing.documents?.length ?? 0) > 0) return;

    // ── Documentos: MERGE aditivo, nunca substitui ─────────────────────────────
    // O SEI só renderiza docs da pasta aberta; se replaçássemos a lista, perderíamos
    // tudo que já estava cacheado. Aqui: preserva existentes, adiciona novos (por docId
    // ou título exato), e atualiza títulos quando a nova versão tem mais info (badge de unidade).
    const existingDocs = existing.documents ?? [];

    // Indexa existentes por docId (5-8 dígitos) E por título exato
    const existingByDocId = new Map<string, { title: string; idx: number }>();
    const existingByTitle = new Set<string>(existingDocs);
    existingDocs.forEach((t, idx) => {
      const m = t.match(/\b(\d{5,8})\b/);
      if (m) existingByDocId.set(m[1], { title: t, idx });
    });

    const mergedDocs = [...existingDocs];
    let addedCount = 0;
    let upgradedCount = 0;

    for (const newTitle of documents) {
      const m = newTitle.match(/\b(\d{5,8})\b/);
      if (m) {
        const docId = m[1];
        const found = existingByDocId.get(docId);
        if (found) {
          // Já existe — só substitui se a nova versão tem MAIS info (texto mais longo,
          // ex: ganhou badge de unidade que antes não tinha)
          if (newTitle.length > found.title.length && newTitle !== found.title) {
            mergedDocs[found.idx] = newTitle;
            existingByTitle.delete(found.title);
            existingByTitle.add(newTitle);
            existingByDocId.set(docId, { title: newTitle, idx: found.idx });
            upgradedCount++;
          }
        } else {
          // Novo doc — adiciona
          mergedDocs.push(newTitle);
          existingByTitle.add(newTitle);
          existingByDocId.set(docId, { title: newTitle, idx: mergedDocs.length - 1 });
          addedCount++;
        }
      } else if (!existingByTitle.has(newTitle)) {
        // Sem docId numérico (raro: títulos como "I", "II") — dedup por texto exato
        mergedDocs.push(newTitle);
        existingByTitle.add(newTitle);
        addedCount++;
      }
    }

    if (documents.length > 0) {
      console.log(
        `[SEI Assistant] Docs merged: +${addedCount} novos, ${upgradedCount} atualizados | total ${mergedDocs.length} (extração atual: ${documents.length})`
      );
    }

    const finalDocs = mergedDocs;
    // Merge links: novos sobrescrevem os existentes
    const finalLinks = { ...(existing.documentLinks ?? {}), ...docLinks };

    // Invalida cache do summary APENAS quando há docs realmente novos (não cobertos antes)
    const docsChanged = addedCount > 0;

    // ── Andamento: merge incremental quando na página de histórico ────────────────
    // Cada "Próxima Página" traz novos registros — acumula em vez de substituir
    let finalAndamento: AndamentoEntry[];
    if (onHistorico && andamento.length > 0) {
      const existingSet = new Set(
        (existing.andamento ?? []).map((e) => `${e.date}|${e.unit}|${e.description}`)
      );
      const newEntries = andamento.filter(
        (e) => !existingSet.has(`${e.date}|${e.unit}|${e.description}`)
      );
      finalAndamento = [...(existing.andamento ?? []), ...newEntries];
      console.log(
        `[SEI Assistant] Andamento merged: +${newEntries.length} novos | total ${finalAndamento.length}`
      );
    } else {
      finalAndamento = andamento.length > 0 ? andamento : (existing.andamento ?? []);
    }

    const updated: ProcessDetails = {
      id,
      type: header.type ?? existing.type ?? null,
      description: header.description ?? existing.description ?? null,
      currentUnit: header.currentUnit ?? existing.currentUnit ?? null,
      parties: header.parties.length > 0 ? header.parties : (existing.parties ?? []),
      documents: finalDocs,
      documentLinks: finalLinks,
      andamento: finalAndamento,
      extractedAt: Date.now(),
      summary: docsChanged ? null : (existing.summary ?? null),
      // Preserva despachosContent — só limpa se solicitado explicitamente via runFullCollection
      despachosContent: existing.despachosContent ?? null,
    };

    // Salva mapeamento processNumber → id_procedimento (numérico interno do SEI)
    const internalId = new URL(window.location.href).searchParams.get("id_procedimento");
    if (internalId) {
      safeStorageSet({ [`procInternalId_${id}`]: internalId });
    }

    // ── Alerta de movimentação ─────────────────────────────────────────────────────
    // Processo já coletado (tinha resumo) ganhou andamento novo ou documentos novos
    // → sinaliza para a sidebar/portfólio avisar que os dados estão desatualizados.
    const novasMovs = finalAndamento.length - (existing.andamento?.length ?? 0);
    const novidades = Math.max(novasMovs, 0) + addedCount;
    if (existing.summary && novidades > 0) {
      storageGet(`moved_${id}`).then((mr) => {
        const prev = (mr[`moved_${id}`] as { count?: number } | undefined)?.count ?? 0;
        safeStorageSet({ [`moved_${id}`]: { count: prev + novidades, at: Date.now() } });
        console.log(`[SEI Assistant] 🔔 Processo ${id}: ${prev + novidades} novidade(s) desde a última coleta`);
      });
    }

    safeStorageSet({ [storageKey]: updated });
    console.log(`[SEI Assistant] Detalhes salvos para processo ${id}`, updated);

    // Tenta abrir "Consultar Andamento" automaticamente se ainda não temos andamento
    if (finalAndamento.length === 0) {
      tryAutoOpenAndamento(id);
    }

    // ── Paginação automática do histórico ─────────────────────────────────────────
    // Se há próxima página, clica automaticamente → dispara nova extração ao carregar
    if (onHistorico && andamento.length > 0) {
      const nextLink = findNextPageLink();
      if (nextLink) {
        console.log(`[SEI Assistant] Próxima página do histórico — clicando automaticamente`);
        setTimeout(() => {
          if (!isContextValid()) return;
          try { safeClick(nextLink); } catch { /* ignora */ }
        }, 400);
      } else {
        console.log(`[SEI Assistant] Histórico completo: ${finalAndamento.length} registros extraídos`);
      }
    }
  });
}

function isHistoricoPage(): boolean {
  // Check definitivo: tabela #tblHistorico — no próprio doc ou em iframes filhos
  if (document.querySelector("#tblHistorico")) return true;
  try {
    const doc = getHistoricoDoc();
    if (doc !== document && doc.querySelector("#tblHistorico")) return true;
  } catch { /* cross-origin */ }

  const action = getActionFromUrl(window.location.href);
  if (action && /historico|andamento/i.test(action)) return true;

  // Título em qualquer heading ou elemento de destaque
  const titleEls = document.querySelectorAll(
    "h1, h2, h3, h4, caption, .infraTituloBloco, [class*='titulo'], [class*='Titulo'], b, strong"
  );
  for (const h of titleEls) {
    if (/hist.rico\s+do\s+processo/i.test(h.textContent ?? "")) return true;
  }
  if (/hist.rico\s+do\s+processo/i.test(document.title)) return true;

  // Table-based: th OU tr:first-child td com "Data" + "Unidade" + "Descri"
  const candidates = [
    ...Array.from(document.querySelectorAll("th")),
    ...Array.from(document.querySelectorAll("table tr:first-child td")),
  ];
  const texts = candidates.map((el) => el.textContent?.replace(/\s+/g, " ").toLowerCase().trim() ?? "");
  return texts.some((h) => h.includes("data")) &&
    texts.some((h) => h.includes("unidade")) &&
    texts.some((h) => h.includes("descri") || h.includes("movimento"));
}

function tryExtractAndSaveDetails() {
  const action = getActionFromUrl(window.location.href);
  const hasTreeNodes = document.querySelectorAll(".infraArvoreNo").length > 0;
  const isTreeFrame = action === "arvore_visualizar" || hasTreeNodes;
  const isHistorico = isHistoricoPage();

  console.log(`[SEI Assistant] tryExtract: action=${action} isHistorico=${isHistorico} treeNodes=${document.querySelectorAll(".infraArvoreNo").length}`);

  // Quando na página de histórico, salva a URL para o background usar diretamente
  if (isHistorico) {
    const id = getCurrentProcessId();
    if (id) safeStorageSet({ [`historicoUrl_${id}`]: window.location.href });
  }

  // Só roda em frames relevantes
  if (!isHistorico && !hasTreeNodes && (!action || !DETAIL_ACTIONS.includes(action))) return;

  if (detailDebounce) clearTimeout(detailDebounce);
  detailDebounce = setTimeout(() => {
    // Tenta obter o ID do processo — em frames aninhados (ifrVisualizacao) o número
    // pode não estar no DOM; nesse caso faz lookup reverso pelo id_procedimento na URL
    const id = getCurrentProcessId();
    if (!id) {
      const internalId = new URL(window.location.href).searchParams.get("id_procedimento");
      if (internalId && isHistorico) {
        // Busca qual processo corresponde a este id_procedimento interno
        chrome.storage.local.get(null, (all) => {
          if (!isContextValid()) return;
          const key = Object.keys(all).find(
            (k) => k.startsWith("procInternalId_") && all[k] === internalId
          );
          if (key) {
            const procId = key.replace("procInternalId_", "");
            doExtractAndSave(procId);
            safeStorageSet({ [`historicoUrl_${procId}`]: window.location.href });
          }
        });
      }
      return;
    }

    // Frame da árvore: aguarda AJAX carregar os nós antes de extrair
    if (isTreeFrame) {
      const docsNow = document.querySelectorAll(".infraArvoreNo").length;
      if (docsNow > 0) {
        doExtractAndSave(id);
      } else {
        treePollerAttempts = 0;
        startTreePoller(id);
      }
      return;
    }

    // Página de histórico/andamento: extrai e salva
    doExtractAndSave(id);
  }, 600);
}

// ─── Coleta completa guiada ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setCollectionProgress(
  processId: string,
  phase: string,
  step: number,
  totalSteps: number,
  status: "running" | "done" | "error" = "running",
  error?: string
) {
  safeStorageSet({
    [`collecting_${processId}`]: { processId, status, phase, step, totalSteps, startedAt: Date.now(), error },
  });
}

/** Checa se o usuário cancelou a coleta via UI (flag em storage). */
async function isCancelled(processId: string): Promise<boolean> {
  if (!isContextValid()) return true;
  try {
    const r = await storageGet(`cancelCollection_${processId}`);
    return !!r[`cancelCollection_${processId}`];
  } catch {
    return true;
  }
}

/** Sleep que retorna true se foi cancelado durante a espera. */
async function sleepCancellable(ms: number, processId: string): Promise<boolean> {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms) {
    await sleep(Math.min(step, ms - elapsed));
    elapsed += step;
    if (await isCancelled(processId)) return true;
  }
  return false;
}

/** Coleta todos os Documents acessíveis (same-origin) do frame atual e filhos */
function getAllAccessibleDocs(): Document[] {
  const docs: Document[] = [document];

  function crawl(win: Window) {
    try {
      for (let i = 0; i < win.frames.length; i++) {
        try {
          const child = win.frames[i] as Window;
          const childDoc = child.document;
          if (childDoc && !docs.includes(childDoc)) {
            docs.push(childDoc);
            crawl(child); // recursivo para iframes aninhados
          }
        } catch { /* cross-origin — ignora */ }
      }
    } catch { /* ignora */ }
  }

  crawl(window);
  return docs;
}

/** É um link/botão de ação (copiar, clipboard) — NÃO abre o documento. */
function isActionLink(a: Element): boolean {
  const blob = [
    a.getAttribute?.("onclick"), a.getAttribute?.("href"),
    a.getAttribute?.("title"), a.getAttribute?.("aria-label"),
  ].join(" ");
  return /copiar|clipboard|copy|writeText|imprimir|download|baixar/i.test(blob);
}

/** O link/onclick referencia ABRIR/VISUALIZAR um documento com este docId. */
function opensDocument(a: Element, docId: string): boolean {
  const href = a.getAttribute?.("href") ?? "";
  const onclick = a.getAttribute?.("onclick") ?? "";
  // href direto com a ação de visualizar + id_documento
  if (new RegExp(`id_documento=${docId}(?![0-9])`).test(href + " " + onclick)) return true;
  // onclick que abre/visualiza documento contendo o docId isolado
  if (/documento_visualizar|visualizar_documento|abrirDocumento|infraArvore/i.test(onclick)
      && new RegExp(`(?<![0-9])${docId}(?![0-9])`).test(onclick)) return true;
  return false;
}

/** Clica no link que ABRE um despacho na árvore (evita botões de copiar/clipboard). */
function clickDespachoInTree(docId: string, titleHint = ""): boolean {
  for (const doc of getAllAccessibleDocs()) {
    try {
      const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => !isActionLink(a));

      // Estratégia 1: link que comprovadamente ABRE o documento
      for (const a of anchors) {
        if (opensDocument(a, docId)) {
          safeClick(a);
          console.log(`[SEI Assistant] ✓ Abriu despacho ${docId} (estratégia 1)`);
          return true;
        }
      }

      // Estratégia 2: nó da árvore cujo texto inclui o docId → clica no link do NOME
      for (const node of doc.querySelectorAll(".infraArvoreNo")) {
        if (!(node.textContent ?? "").includes(docId)) continue;
        const anchor = (node.closest<HTMLAnchorElement>("a") ?? node.querySelector<HTMLAnchorElement>("a"));
        if (anchor && !isActionLink(anchor)) {
          safeClick(anchor);
          console.log(`[SEI Assistant] ✓ Abriu despacho ${docId} (estratégia 2)`);
          return true;
        }
      }

      // Estratégia 3: texto do link contém o docId ou início do título (sem botões de ação)
      const hint = titleHint ? titleHint.replace(/despacho\s+\d+\s*/i, "").slice(0, 15).toLowerCase() : "";
      for (const a of anchors) {
        const text = (a.textContent ?? "").toLowerCase();
        if (text.includes(docId) || (hint.length > 4 && text.includes(hint))) {
          safeClick(a);
          console.log(`[SEI Assistant] ✓ Abriu despacho ${docId} (estratégia 3)`);
          return true;
        }
      }
    } catch { /* ignora frame */ }
  }
  console.warn(`[SEI Assistant] ✗ Link do despacho ${docId} não encontrado`);
  return false;
}

const RESTRICTED_PATTERNS = [
  /processo aberto somente na unidade/i,
  /documento restrito/i,
  /acesso negado/i,
  /sem permissão/i,
  /você não tem permissão/i,
];

function isRestrictedContent(text: string): boolean {
  return RESTRICTED_PATTERNS.some((p) => p.test(text.slice(0, 200)));
}

/** Verifica se um despacho está marcado como restrito na árvore (ícone vermelho cortado) */
function isDocRestrictedInTree(docId: string): boolean {
  for (const doc of getAllAccessibleDocs()) {
    try {
      for (const a of doc.querySelectorAll<HTMLAnchorElement>("a")) {
        const attrs = Array.from(a.attributes).map((x) => x.value).join(" ");
        if (!new RegExp(`(?<![0-9])${docId}(?![0-9])`).test(attrs)) continue;

        // Verifica ícone de restrição: img com src "restrito", "bloqueado", "cancelado", cor vermelha
        const parent = a.closest("span, div, li, td") ?? a.parentElement;
        const imgs = parent?.querySelectorAll<HTMLImageElement>("img") ?? [];
        for (const img of imgs) {
          const src = (img.src ?? "").toLowerCase();
          if (/restrit|bloqueado|cancelado|proibid|naopermit|cadeado|lock/i.test(src)) return true;
        }

        // Verifica classe CSS de restrição no link ou elemento pai
        const fullClass = [a.className, parent?.className ?? ""].join(" ").toLowerCase();
        if (/restrit|bloqueado|sem.?permiss/i.test(fullClass)) return true;

        return false; // encontrou o link mas sem restrição
      }
    } catch { /* ignora */ }
  }
  return false;
}

/**
 * Detecta, ANTES de abrir, se o documento é um arquivo externo não-textual (PDF, imagem,
 * planilha, zip…) pelo ícone de tipo na árvore. Esses não têm texto legível via DOM —
 * abri-los só gasta tempo até o timeout. Retorna a extensão detectada ou null.
 */
function getExternalFileType(docId: string): string | null {
  const EXT_RE = /\b(pdf|docx?|xlsx?|pptx?|odt|ods|zip|rar|7z|mp[34]|m4a|wav|avi|mov|mkv)\b/;
  for (const doc of getAllAccessibleDocs()) {
    try {
      for (const a of doc.querySelectorAll<HTMLAnchorElement>("a")) {
        const attrs = Array.from(a.attributes).map((x) => x.value).join(" ");
        if (!new RegExp(`(?<![0-9])${docId}(?![0-9])`).test(attrs)) continue;

        // O ícone de tipo de arquivo fica numa <img> dentro do nó da árvore
        const parent = a.closest("span, div, li, td") ?? a.parentElement;
        const imgs = parent?.querySelectorAll<HTMLImageElement>("img") ?? [];
        for (const img of imgs) {
          const blob = `${img.getAttribute("src") ?? ""} ${img.getAttribute("alt") ?? ""} ${img.getAttribute("title") ?? ""}`.toLowerCase();
          const m = blob.match(EXT_RE);
          if (m) return m[1];
        }
        return null; // achou o link, mas sem ícone de arquivo externo (provável doc interno legível)
      }
    } catch { /* ignora frame */ }
  }
  return null;
}

/**
 * Aguarda conteúdo do documento via storage.
 * O content script rodando no frame do documento salva em docContent_${docId}.
 * Mais confiável que tentar acessar o iframe diretamente (evita problemas cross-frame).
 */
async function waitForDespachoContent(docId: string, timeoutMs = 8000): Promise<string> {
  const key = `docContent_${docId}`;
  if (!isContextValid()) return "";
  safeStorageRemove(key);

  const deadline = Date.now() + timeoutMs;
  let elapsed = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    elapsed += 500;
    if (!isContextValid()) return "";

    try {
      // 1. Verifica storage (set por trySaveDocContent no frame filho)
      const result = await storageGet(key);
      const stored = result[key] as string | undefined;
      if (stored && stored.length > 50) {
        safeStorageRemove(key);
        return stored;
      }

      // 2. Tenta extrair diretamente dos frames acessíveis do top-frame
      const direct = extractDocContentFromAllFrames(docId);
      if (direct.length > 50) return direct;

      // 3. Após ~1s, se for um PDF nativo (texto não acessível via DOM), desiste cedo.
      //    (Rede de segurança — a maioria dos PDFs já é pulada antes de abrir, pelo ícone da árvore.)
      if (elapsed >= 1000 && hasNativePdfViewer()) {
        console.log(`[SEI Assistant] Documento ${docId}: PDF externo (texto não legível via DOM) — pulando`);
        return "";
      }
    } catch {
      // Contexto invalidado durante a espera
      return "";
    }
  }
  return "";
}

async function runFullCollection(processId: string) {
  if (!isTopFrame) return;
  const TOTAL = 4;

  // Limpa qualquer flag de cancelamento residual antes de começar
  safeStorageRemove(`cancelCollection_${processId}`);

  const checkCancel = async (): Promise<boolean> => {
    if (await isCancelled(processId)) {
      console.log(`[SEI Assistant] Coleta cancelada pelo usuário (${processId})`);
      setCollectionProgress(processId, "Coleta cancelada pelo usuário.", 0, TOTAL, "error", "Cancelado");
      safeStorageRemove(`cancelCollection_${processId}`);
      return true;
    }
    return false;
  };

  try {
    // ── Passo 1: Expandir árvore (múltiplas rodadas para árvores profundas) ──────
    setCollectionProgress(processId, "Expandindo árvore de documentos…", 1, TOTAL);
    let totalExpanded = 0;
    for (let round = 0; round < 4; round++) {
      if (await checkCancel()) return;
      const n = tryAutoExpandTree();
      totalExpanded += n;
      if (n === 0) break;           // nada mais para expandir
      if (await sleepCancellable(2000, processId)) { await checkCancel(); return; }
    }
    console.log(`[SEI Assistant] Expansão concluída: ${totalExpanded} nó(s) total`);
    if (await sleepCancellable(500, processId)) { await checkCancel(); return; }
    doExtractAndSave(processId);    // re-extrai com árvore completa
    if (await sleepCancellable(800, processId)) { await checkCancel(); return; }

    // ── Passo 2: Abrir Consultar Andamento + paginar ──────────────────────────
    setCollectionProgress(processId, "Abrindo histórico de tramitação…", 2, TOTAL);
    autoAndamentoOpened.delete(processId);
    // Retry: a toolbar do SEI pode demorar a renderizar após a navegação
    const andBtn = await findAndamentoButtonWithRetry(processId);
    if (andBtn) {
      safeClick(andBtn);
      // Espera adaptativa: monitora storage até o andamento estabilizar
      // (paginação automática vai adicionando linhas; quando para de crescer por 3s, completou)
      const ANDAMENTO_TIMEOUT = 60000; // limite máximo 60s para processos enormes
      const STABLE_WINDOW = 3000;       // sem crescimento por 3s = estável
      const deadline = Date.now() + ANDAMENTO_TIMEOUT;
      let lastCount = -1;
      let lastChange = Date.now();

      while (Date.now() < deadline) {
        if (await sleepCancellable(1000, processId)) { await checkCancel(); return; }
        const snap = await storageGet(`proc_${processId}`);
        const cur = (snap[`proc_${processId}`] as ProcessDetails | undefined)?.andamento?.length ?? 0;

        if (cur !== lastCount) {
          lastCount = cur;
          lastChange = Date.now();
          setCollectionProgress(
            processId,
            `Coletando histórico de tramitação… (${cur} registros)`,
            2, TOTAL
          );
        } else if (cur > 0 && Date.now() - lastChange >= STABLE_WINDOW) {
          // Estabilizou — paginação completou
          console.log(`[SEI Assistant] Andamento estabilizou em ${cur} registros`);
          break;
        }
      }
      if (lastCount === 0) {
        console.log("[SEI Assistant] Andamento vazio após timeout — seguindo sem datas");
      }
    } else {
      // Não achou o botão — mas pode já ter andamento coletado antes (auto-open).
      // Só é problema se não houver histórico nenhum no storage.
      const snap = await storageGet(`proc_${processId}`);
      const jaTem = ((snap[`proc_${processId}`] as ProcessDetails | undefined)?.andamento?.length ?? 0) > 0;
      if (jaTem) {
        console.log("[SEI Assistant] Andamento já coletado — passo 2 dispensado");
      } else {
        console.log("[SEI Assistant] Botão 'Consultar Andamento' não encontrado — histórico não coletado neste processo");
      }
    }

    // ── Passo 3: Ler documentos via clique na árvore ────────────────────────
    // Prioridade: docs ricos (termo, contrato, DFD, etc.) → depois despachos
    if (await sleepCancellable(1500, processId)) { await checkCancel(); return; }
    const raw = await storageGet(`proc_${processId}`);
    const details = raw[`proc_${processId}`] as ProcessDetails | undefined;

    const DESPACHO_RE = /^despacho\s+\d+/i;
    const allDocs = details?.documents ?? [];
    const despachoTitles = allDocs.filter((d) => DESPACHO_RE.test(d));

    // Documentos importantes (Termo de Referência, Contrato, Parecer, DFD…) primeiro,
    // depois os despachos. Dedup por docId para não ler o mesmo duas vezes.
    const importantTitles = extractImportantDocs(allDocs).map((d) => d.title);
    const toRead: string[] = [];
    const seenRead = new Set<string>();
    for (const title of [...importantTitles, ...despachoTitles]) {
      const id = title.match(/\b(\d{5,8})\b/)?.[1];
      const key = id ?? title;
      if (seenRead.has(key)) continue;
      seenRead.add(key);
      toRead.push(title);
    }
    console.log(`[SEI Assistant] Lendo ${toRead.length} documento(s): ${importantTitles.length} importantes + ${despachoTitles.length} despachos`);

    if (toRead.length > 0) {
      const despachoTexts: Record<string, string> = {};
      let readCount = 0;

      for (let i = 0; i < toRead.length; i++) {
        if (!isContextValid()) break;
        if (await checkCancel()) return;
        const title = toRead[i];
        const docId = title.match(/\b(\d{5,8})\b/)?.[1];
        if (!docId) continue;

        // Pula documentos restritos sem tentar clicar
        if (isDocRestrictedInTree(docId)) {
          console.log(`[SEI Assistant] Documento ${docId}: restrito — pulando`);
          continue;
        }

        // Arquivo externo (PDF, imagem, planilha…): texto não é legível via DOM.
        // O nome já está na lista de documentos — pula a leitura sem abrir/esperar timeout.
        const fileExt = getExternalFileType(docId);
        if (fileExt) {
          console.log(`[SEI Assistant] Documento ${docId}: arquivo .${fileExt} externo — nome registrado, leitura pulada`);
          continue;
        }

        setCollectionProgress(
          processId,
          `Lendo documento ${i + 1} de ${toRead.length}… (${readCount} lidos)`,
          3,
          TOTAL
        );

        try {
          const clicked = clickDespachoInTree(docId, title);
          if (clicked) {
            const text = await waitForDespachoContent(docId, 8000);
            console.log(`[SEI Assistant] Documento ${docId}: ${text.length > 0 ? text.length + " chars ✓" : "timeout"}`);
            if (text.length > 50) {
              readCount++;
              despachoTexts[title] = text;
              console.log(`[SEI Assistant] Documento "${title}" lido (${text.length} chars)`);
            }
          }
        } catch (e) {
          console.warn(`[SEI Assistant] Erro ao ler documento "${title}":`, e);
        }

        if (await sleepCancellable(200, processId)) { await checkCancel(); return; }
      }

      if (Object.keys(despachoTexts).length > 0) {
        // Merge por docId — sem duplicatas. Reconstrói o mapa de conteúdo existente
        const existingMap: Record<string, string> = {};
        const existingContent = details?.despachosContent ?? "";
        // Parseia seções "=== Título ===" do conteúdo anterior
        const sectionRe = /===\s*(.*?)\s*===\n([\s\S]*?)(?====|\s*$)/g;
        let match;
        while ((match = sectionRe.exec(existingContent)) !== null) {
          existingMap[match[1].trim()] = match[2].trim();
        }

        // Merge: novos sobrescrevem existentes pelo título
        const mergedMap = { ...existingMap, ...despachoTexts };
        const despachosContent = Object.entries(mergedMap)
          .map(([t, c]) => `=== ${t} ===\n${c}`)
          .join("\n\n");

        const updatedDetails = { ...details, despachosContent };
        safeStorageSet({ [`proc_${processId}`]: updatedDetails });
        console.log(`[SEI Assistant] ${Object.keys(despachoTexts).length} novo(s) | ${Object.keys(mergedMap).length} total | ${despachosContent.length} chars`);
      }
    }

    // ── Passo 4: Gerar resumo com IA ──────────────────────────────────────────
    if (!isContextValid()) return;
    setCollectionProgress(processId, "Gerando resumo com IA…", 4, TOTAL);
    safeStorageRemove(`moved_${processId}`); // recoletado → alerta de movimentação resolvido
    safeSendMessage({ type: "COLLECTION_DONE", payload: { processId } });

    // Se faz parte de uma fila em lote, avança para o próximo processo
    await maybeAdvanceQueue(processId, true);

  } catch (e) {
    console.error("[SEI Assistant] Erro na coleta:", e);
    // Contexto pode ter sido invalidado — protege o set
    if (isContextValid()) {
      setCollectionProgress(processId, "Erro durante a coleta.", 0, TOTAL, "error", String(e));
      // Mesmo com erro, avança a fila para não travar o lote
      await maybeAdvanceQueue(processId, false);
    }
  }
}

// ─── Fila de coleta em lote ───────────────────────────────────────────────────
// Persistida em storage `collectionQueue`. Cada processo é coletado via o mesmo
// fluxo de pendingCollection + navegação; ao terminar um, dispara o próximo.

/**
 * Avança a fila após terminar um processo. Retorna true se havia fila ativa.
 * success=false marca o processo como falho mas mantém o lote rodando.
 */
async function maybeAdvanceQueue(finishedId: string, success: boolean): Promise<boolean> {
  if (!isContextValid()) return false;
  const q = (await storageGet("collectionQueue")).collectionQueue as CollectionQueueState | undefined;
  if (!q || q.status !== "running" || q.current !== finishedId) return false;

  const done = success ? [...q.done, finishedId] : q.done;
  const failed = success ? q.failed : [...q.failed, finishedId];

  if (q.remaining.length === 0) {
    // Fila concluída
    safeStorageSet({ collectionQueue: { ...q, current: null, done, failed, status: "done" } });
    console.log(`[SEI Assistant] Fila concluída: ${done.length} ok, ${failed.length} falhas`);
    return true;
  }

  const [next, ...rest] = q.remaining;
  safeStorageSet({
    collectionQueue: { ...q, current: next, remaining: rest, done, failed },
    [`pendingCollection_${next}`]: true,
  });
  setCollectionProgress(next, "Próximo da fila…", 0, 4);
  console.log(`[SEI Assistant] Fila avança para ${next} (${done.length + failed.length + 1}/${q.total})`);

  // Navega para o Controle de Processos para abrir o próximo
  // (se já estiver lá, o tryAutoOpenPendingProcess cuida; senão navega)
  setTimeout(() => {
    if (!isContextValid()) return;
    if (isProcessListPage()) tryAutoOpenPendingProcess();
    else navigateToControleProcessos();
  }, 600);
  return true;
}

function startQueue(processIds: string[]): boolean {
  if (!processIds.length) return false;
  const [first, ...rest] = processIds;
  const queue: CollectionQueueState = {
    current: first, remaining: rest, done: [], failed: [],
    total: processIds.length, status: "running", startedAt: Date.now(),
  };
  safeStorageSet({ collectionQueue: queue, [`pendingCollection_${first}`]: true });
  setCollectionProgress(first, "Iniciando fila…", 0, 4);

  if (isProcessListPage()) {
    tryAutoOpenPendingProcess();
    return true;
  }
  return navigateToControleProcessos();
}

function stopQueue() {
  chrome.storage.local.get(null, (all) => {
    if (!isContextValid()) return;
    const q = all.collectionQueue as CollectionQueueState | undefined;
    // Cancela o processo em andamento e remove pendings
    if (q?.current) safeStorageSet({ [`cancelCollection_${q.current}`]: true });
    for (const k of Object.keys(all)) {
      if (k.startsWith("pendingCollection_")) chrome.storage.local.remove(k);
    }
    chrome.storage.local.remove("collectionQueue");
    console.log("[SEI Assistant] Fila interrompida pelo usuário");
  });
}

// ─── Navegação segura para Controle de Processos ──────────────────────────────
// IMPORTANTE: NUNCA usar window.location.href com URL construída manualmente —
// `infra_hash` é obrigatório e de uso único. Sem ele, o SEI redireciona pro login.
// Solução: encontrar e clicar num link existente do SEI (que tem hash fresco do servidor).

function navigateToControleProcessos(): boolean {
  // Clica em qualquer link/ícone REAL do SEI que leva ao Controle de Processos.
  // Esses links carregam o infra_hash fresco do servidor — clicar é seguro.
  // NUNCA construímos a URL manualmente (hash de uso único → deslogaria).
  const isRealSeiLink = (href: string) =>
    /controlador\.php/i.test(href) && /acao=procedimento_controlar/i.test(href);

  for (const doc of getAllAccessibleDocs()) {
    try {
      // Estratégia 1: link <a> real para procedimento_controlar (prioriza com hash)
      const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href*='procedimento_controlar']"))
        .filter((a) => isRealSeiLink(a.getAttribute("href") ?? ""));
      if (anchors.length) {
        const withHash = anchors.find((a) => (a.getAttribute("href") ?? "").includes("infra_hash="));
        const target = withHash ?? anchors[0];
        console.log("[SEI Assistant] Navegando via link de Controle de Processos");
        safeClick(target);
        return true;
      }

      // Estratégia 2: ícone/imagem da barra superior com title/alt "Controle de Processos"
      const iconEls = doc.querySelectorAll<HTMLElement>(
        "[title*='Controle de Processos'], [alt*='Controle de Processos'], img[title*='Controle de Processos']"
      );
      for (const el of iconEls) {
        const anchor = el.closest<HTMLAnchorElement>("a") ?? (el.tagName === "A" ? (el as HTMLAnchorElement) : null);
        if (anchor) {
          console.log("[SEI Assistant] Navegando via ícone da barra superior");
          safeClick(anchor);
          return true;
        }
      }

      // Estratégia 3: qualquer elemento com onclick para procedimento_controlar
      const onclickEl = doc.querySelector<HTMLElement>("[onclick*='procedimento_controlar']");
      if (onclickEl) {
        const anchor = onclickEl.closest<HTMLAnchorElement>("a") ?? onclickEl;
        console.log("[SEI Assistant] Navegando via onclick");
        safeClick(anchor);
        return true;
      }
    } catch { /* frame inacessível */ }
  }

  console.warn("[SEI Assistant] Nenhum link de 'Controle de Processos' encontrado nos frames acessíveis");
  return false;
}

// ─── Revisão por agentes: listar e ler documentos da árvore ─────────────────────
// Validado no SEI 5.0.5: buscar (fetch) um link REAL do SEI é seguro e reutilizável;
// nunca montamos URL. Só seguimos links de leitura (allowlist em ehLinkDeLeitura).

async function listarDocumentosRevisao(): Promise<DocArvore[]> {
  const arvore = (document.getElementById("ifrArvore") as HTMLIFrameElement | null)?.contentDocument;
  if (!arvore) throw new Error("Abra um processo no SEI (a árvore de documentos não está visível).");
  // "Abrir todas as Pastas": buscar o link traz TODOS os documentos sem mexer na tela.
  const abrirTudo = arvore.querySelector<HTMLAnchorElement>("a[id^='anchorAP']")?.getAttribute("href");
  const html = abrirTudo
    ? await textoDaResposta(await fetch(new URL(abrirTudo, location.href), { credentials: "same-origin" }))
    : arvore.documentElement.outerHTML;
  return parseArvore(html);
}

// O SEI responde "charset=ISO-8859-1"; Response.text() sempre decodifica como UTF-8 e
// estragaria acentos crus (títulos, documentos antigos). Decodifica pelo charset do servidor.
async function textoDaResposta(r: Response): Promise<string> {
  const charset = /charset=([\w-]+)/i.exec(r.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
  const buf = await r.arrayBuffer();
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

function bytesParaBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function lerDocumentosRevisao(ids: string[]) {
  const docs = await listarDocumentosRevisao(); // links sempre frescos da árvore atual
  const saida: { idInterno: string; titulo: string; tipo: string; texto?: string; pdfBase64?: string; erro?: string }[] = [];
  for (const id of ids) {
    const d = docs.find((x) => x.idInterno === id);
    if (!d || !ehLinkDeLeitura(d.src)) { saida.push({ idInterno: id, titulo: d?.titulo ?? id, tipo: "?", erro: "documento não encontrado na árvore" }); continue; }
    try {
      const r = await fetch(new URL(d.src, location.href), { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (/pdf/i.test(r.headers.get("content-type") ?? "")) {
        saida.push({ idInterno: id, titulo: d.titulo, tipo: d.tipo, pdfBase64: bytesParaBase64(new Uint8Array(await r.arrayBuffer())) });
      } else {
        saida.push({ idInterno: id, titulo: d.titulo, tipo: d.tipo, texto: htmlParaTexto(await textoDaResposta(r)) });
      }
    } catch (e) {
      saida.push({ idInterno: id, titulo: d.titulo, tipo: d.tipo, erro: String(e) });
    }
  }
  return saida;
}

// ─── Listener de mensagens da sidebar ──────────────────────────────────────────

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isContextValid()) { sendResponse({ ok: false }); return; }

    // Revisão: só o frame do topo responde (ele enxerga o iframe da árvore)
    if (message.type === "REVISAO_LISTAR" || message.type === "REVISAO_LER") {
      if (!isTopFrame) return;
      const tarefa = message.type === "REVISAO_LISTAR"
        ? listarDocumentosRevisao().then((docs) => docs.map(({ src: _s, ...resto }) => resto))
        : lerDocumentosRevisao((message.payload?.ids ?? []) as string[]);
      tarefa.then((dados) => sendResponse({ ok: true, dados }))
        .catch((e) => sendResponse({ ok: false, erro: String(e?.message ?? e) }));
      return true;
    }

    if (message.type === "COLLECT_PROCESSES") {
      if (isProcessListPage()) {
        tryCollectAndSave();
        sendResponse({ ok: true, onPage: true });
      } else {
        sendResponse({ ok: false, onPage: false });
      }
      return true;
    }

    if (message.type === "EXPAND_TREE") {
      const expanded = tryAutoExpandTree();
      if (expanded > 0) {
        setTimeout(() => {
          if (!isContextValid()) return;
          const id = getCurrentProcessId();
          if (id) doExtractAndSave(id);
        }, 2500);
      }
      sendResponse({ ok: true, expanded });
      return true;
    }

    if (message.type === "STOP_COLLECTION") {
      const { processId } = (message.payload ?? {}) as { processId: string };
      // Seta flag — runFullCollection checa entre as etapas e aborta limpo
      safeStorageSet({ [`cancelCollection_${processId}`]: true });
      // Também limpa pendingCollection caso ainda nem tenha começado
      chrome.storage.local.remove(`pendingCollection_${processId}`);
      console.log(`[SEI Assistant] Cancelamento solicitado para ${processId}`);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "START_QUEUE") {
      const { processIds } = (message.payload ?? {}) as { processIds: string[] };
      const started = startQueue(processIds ?? []);
      sendResponse({ ok: started, count: processIds?.length ?? 0 });
      return true;
    }

    if (message.type === "STOP_QUEUE") {
      stopQueue();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "START_COLLECTION") {
      const { processId } = (message.payload ?? {}) as { processId: string };
      const action = getActionFromUrl(window.location.href);
      const onProcessPage = action
        ? ["procedimento_trabalhar", "arvore_visualizar", "procedimento_visualizar"].includes(action)
        : false;
      const currentId = getCurrentProcessId();
      const isCorrectProcess = currentId === processId;

      if (onProcessPage && isCorrectProcess) {
        // Já estamos no processo certo — inicia direto
        sendResponse({ ok: true, navigating: false });
        runFullCollection(processId);
      } else {
        // Salva flag e navega para o Controle de Processos
        safeStorageSet({ [`pendingCollection_${processId}`]: true });
        setCollectionProgress(processId, "Navegando para o Controle de Processos…", 0, 4);

        const navigated = navigateToControleProcessos();
        if (!navigated) {
          // Não achou nenhum link válido — informa o usuário em vez de navegar
          // para URL sem hash (que causaria logout)
          setCollectionProgress(
            processId,
            "Abra 'Controle de Processos' manualmente no SEI e tente de novo.",
            0, 4, "error",
            "Link do Controle de Processos não encontrado nesta página."
          );
          chrome.storage.local.remove(`pendingCollection_${processId}`);
        }
        sendResponse({ ok: true, navigating: navigated });
      }
      return true;
    }

    return true;
  });
}

// ─── Captura template de URL ao abrir documento ────────────────────────────────

function trySaveDocUrlTemplate() {
  const action = getActionFromUrl(window.location.href);
  if (action !== "documento_visualizar") return;

  const params = new URL(window.location.href).searchParams;
  const hash = params.get("infra_hash");
  const idDoc = params.get("id_documento");
  if (!hash || !idDoc) return;

  const template = {
    origin: window.location.origin,
    pathname: window.location.pathname,
    infra_hash: hash,
    infra_sistema: params.get("infra_sistema") ?? "100000100",
    infra_unidade_atual: params.get("infra_unidade_atual") ?? "",
  };
  safeStorageSet({ docUrlTemplate: template });
  console.log(`[SEI Assistant] Template de URL salvo (doc ${idDoc})`);
}

/**
 * Varre TODOS os frames acessíveis recursivamente e retorna
 * o primeiro texto substancial que parece conteúdo de documento SEI.
 */
function extractDocContentFromAllFrames(idDoc: string): string {
  let best = "";
  let bestHasId = false;

  // Considera um bloco de texto como candidato a conteúdo de documento
  function consider(raw: string | null | undefined) {
    const t = (raw ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 120 || isRestrictedContent(t)) return;
    const hasId = t.includes(idDoc);
    // Prioriza o bloco que contém o nº do documento; senão, o maior bloco textual
    if ((hasId && !bestHasId) || (hasId === bestHasId && t.length > best.length)) {
      best = t; bestHasId = hasId;
    }
  }

  // Distingue documento (texto corrido) de árvore/menu (muitos links curtos)
  function looksLikeMenu(el: Element): boolean {
    const links = el.querySelectorAll("a").length;
    const txtLen = el.textContent?.length ?? 1;
    return links > 25 && txtLen / Math.max(links, 1) < 60;
  }

  function crawl(win: Window, depth = 0) {
    if (depth > 5) return;
    try {
      const doc = win.document;

      // PDF pesquisável renderizado com pdf.js — texto fica na camada .textLayer
      const layers = doc.querySelectorAll('.textLayer, [class*="textLayer"]');
      if (layers.length) {
        let pdfText = "";
        layers.forEach((tl) => { pdfText += " " + (tl.textContent ?? ""); });
        consider(pdfText);
      }

      // Containers conhecidos do visualizador SEI (vários nomes possíveis)
      for (const sel of [
        "#divConteudoVisualizacaoInterna",
        "#divConteudoVisualizacao",
        "#divInfraAreaTelaD",
        ".infraAreaTelaD",
        "[id*='ConteudoVisualizacao']",
        "[id*='Visualizacao']",
      ]) {
        doc.querySelectorAll(sel).forEach((el) => {
          if (!looksLikeMenu(el)) consider(el.textContent);
        });
      }

      // Body do frame — aceita se NÃO parece menu/árvore (não exige o nº do doc)
      if (doc.body && !looksLikeMenu(doc.body)) consider(doc.body.textContent);

      for (let i = 0; i < win.frames.length; i++) {
        try { crawl(win.frames[i] as Window, depth + 1); } catch { /* cross-origin */ }
      }
    } catch { /* ignora */ }
  }

  crawl(window);
  return best.slice(0, 8000);
}

/** Detecta um visualizador de PDF (embed/object/plugin) cujo texto não é acessível via DOM. */
function hasNativePdfViewer(): boolean {
  for (const d of getAllAccessibleDocs()) {
    try {
      if (d.querySelector('embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], embed[src*=".pdf"]')) return true;
    } catch { /* cross-origin */ }
  }
  return false;
}

function trySaveDocContent() {
  const action = getActionFromUrl(window.location.href);
  const params = new URL(window.location.href).searchParams;
  const validActions = ["documento_visualizar", "procedimento_visualizar", "procedimento_trabalhar"];
  if (!action || !validActions.includes(action)) return;

  const idDoc = params.get("id_documento");
  if (!idDoc) return;

  // Tenta extrair com polling — aguarda frames filhos carregarem
  let attempts = 0;
  const maxAttempts = 10;
  const interval = setInterval(() => {
    if (!isContextValid()) { clearInterval(interval); return; }
    attempts++;
    const content = extractDocContentFromAllFrames(idDoc);
    if (content) {
      clearInterval(interval);
      safeStorageSet({ [`docContent_${idDoc}`]: content });
      console.log(`[SEI Assistant] Doc ${idDoc} salvo (${content.length} chars, tentativa ${attempts})`);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
    }
  }, 400);
}

// ─── Incorporação de documentos abertos manualmente ─────────────────────────────
// Quando o usuário abre um documento (mesmo fora da coleta), o conteúdo capturado
// é incorporado ao despachosContent do processo atual. Assim, navegar pelos
// despachos enriquece o contexto da IA — basta regenerar o resumo depois.

const incorporatedDocs = new Set<string>();

function incorporateDocContent(idDoc: string, content: string) {
  if (!isTopFrame || !isContextValid()) return;
  if (incorporatedDocs.has(idDoc)) return;
  const procId = getCurrentProcessId();
  if (!procId) return;

  storageGet(`proc_${procId}`).then((r) => {
    if (!isContextValid()) return;
    const details = r[`proc_${procId}`] as ProcessDetails | undefined;
    if (!details) return;

    const existing = details.despachosContent ?? "";
    // Se o conteúdo desse documento já está incorporado, não duplica
    if (existing.includes(idDoc) && existing.length > content.length / 2) {
      incorporatedDocs.add(idDoc);
      return;
    }

    const title = (details.documents ?? []).find((t) => t.includes(idDoc)) ?? `Documento ${idDoc}`;
    const section = `=== ${title} ===\n${content.slice(0, 5000)}`;
    const updated: ProcessDetails = {
      ...details,
      despachosContent: existing ? `${existing}\n\n${section}` : section,
    };
    incorporatedDocs.add(idDoc);
    safeStorageSet({ [`proc_${procId}`]: updated, [`docIncorporated_${procId}`]: Date.now() });
    console.log(`[SEI Assistant] Conteúdo do doc ${idDoc} incorporado ao processo ${procId} (${content.length} chars)`);
  }).catch(() => { /* contexto invalidado */ });
}

// ─── Captura URL do botão ZIP ───────────────────────────────────────────────────

function trySaveZipUrl(processId: string) {
  // Roda em qualquer frame autenticado que tenha a toolbar

  // Estratégia 1: procura qualquer elemento com arquivo_gerar_zip em qualquer atributo
  const allEls = document.querySelectorAll<HTMLElement>("*");
  for (const el of allEls) {
    const attrs = Array.from(el.attributes).map((a) => a.value).join(" ");
    if (!attrs.includes("arquivo_gerar_zip")) continue;

    // Tenta extrair URL de qualquer atributo
    const match = attrs.match(/controlador\.php[^\s'"<>]+arquivo_gerar_zip[^\s'"<>]*/);
    if (match) {
      let zipUrl = match[0];
      if (!zipUrl.startsWith("http")) zipUrl = `${window.location.origin}/sei/${zipUrl}`;
      safeStorageSet({ [`zipUrl_${processId}`]: zipUrl });
      console.log(`[SEI Assistant] URL do ZIP (estratégia 1):`, zipUrl);
      return;
    }
  }

  // Estratégia 2: encontra botão ZIP pelo title e constrói URL substituindo a ação
  // (funciona se o infra_hash é de sessão e não por ação)
  const currentParams = new URL(window.location.href).searchParams;
  const currentAction = currentParams.get("acao");
  const idProc = currentParams.get("id_procedimento");
  const infraHash = currentParams.get("infra_hash");

  if (idProc && infraHash) {
    // Verifica se há um botão ZIP visível na página
    const zipButton = Array.from(allEls).find((el) => {
      const title = (el.getAttribute("title") ?? "").toLowerCase();
      const alt = (el.getAttribute("alt") ?? "").toLowerCase();
      const src = (el as HTMLImageElement).src ?? "";
      return title.includes("zip") || alt.includes("zip") || src.toLowerCase().includes("zip");
    });

    if (zipButton) {
      const qs = new URLSearchParams({
        acao: "arquivo_gerar_zip",
        id_procedimento: idProc,
        infra_sistema: currentParams.get("infra_sistema") ?? "100000100",
        infra_unidade_atual: currentParams.get("infra_unidade_atual") ?? "",
        infra_hash: infraHash,
      });
      const zipUrl = `${window.location.origin}${window.location.pathname}?${qs}`;
      safeStorageSet({ [`zipUrl_${processId}`]: zipUrl });
      console.log(`[SEI Assistant] URL do ZIP (estratégia 2, hash reutilizado):`, zipUrl);
      return;
    }
  }

  // Estratégia 3: tenta construir diretamente se tiver id_procedimento na URL (sem botão ZIP)
  if (idProc && infraHash && currentAction && ["procedimento_trabalhar", "arvore_visualizar"].includes(currentAction)) {
    const qs = new URLSearchParams({
      acao: "arquivo_gerar_zip",
      id_procedimento: idProc,
      infra_sistema: currentParams.get("infra_sistema") ?? "100000100",
      infra_unidade_atual: currentParams.get("infra_unidade_atual") ?? "",
      infra_hash: infraHash,
    });
    const zipUrl = `${window.location.origin}${window.location.pathname}?${qs}`;
    safeStorageSet({ [`zipUrl_${processId}`]: zipUrl });
    console.log(`[SEI Assistant] URL do ZIP (estratégia 3, construída):`, zipUrl);
  }
}

// ─── Observador ─────────────────────────────────────────────────────────────────

let lastKnownAuth = false;

let pendingCollectionCheckDone = false;

function checkAndNotify() {
  const currentlyAuth = isAuthenticated();

  if (currentlyAuth && !lastKnownAuth) {
    console.log("[SEI Assistant] Sessão detectada.");
    notifySessionDetected();
    pendingCollectionCheckDone = false; // reset ao detectar nova sessão
  }
  if (!currentlyAuth && lastKnownAuth) {
    console.log("[SEI Assistant] Sessão encerrada.");
    notifySessionEnded();
  }

  lastKnownAuth = currentlyAuth;

  if (currentlyAuth) {
    tryCollectAndSave();
    tryExtractAndSaveDetails();
    trySaveDocUrlTemplate();
    trySaveDocContent();

    const currentId = getCurrentProcessId();
    if (currentId) {
      trySaveZipUrl(currentId);

      // Checa pendingCollection — roda uma vez por processo após navegação
      if (!pendingCollectionCheckDone && isTopFrame) {
        const action = getActionFromUrl(window.location.href);
        const onProcessPage = action
          ? ["procedimento_trabalhar", "arvore_visualizar", "procedimento_visualizar"].includes(action)
          : false;

        if (onProcessPage) {
          pendingCollectionCheckDone = true;
          const pendingKey = `pendingCollection_${currentId}`;
          chrome.storage.local.get(pendingKey, (r) => {
            if (!isContextValid() || !r[pendingKey]) return;
            chrome.storage.local.remove(pendingKey);
            console.log(`[SEI Assistant] Coleta pendente — iniciando para ${currentId}`);
            setTimeout(() => { if (isContextValid()) runFullCollection(currentId); }, 2000);
          });
        }
      }
    }

    // Se estamos no Controle de Processos COM coleta pendente, clica no link do processo
    if (isTopFrame && isProcessListPage() && !autoOpenedFromList) {
      tryAutoOpenPendingProcess();
    }
  }
}

let autoOpenedFromList = false;

/**
 * Quando o usuário inicia coleta de um processo que NÃO está aberto, o sistema
 * navega para o Controle de Processos. Esta função detecta isso e clica no link
 * do processo automaticamente, evitando passo manual.
 */
function tryAutoOpenPendingProcess() {
  chrome.storage.local.get(null, (all) => {
    if (!isContextValid()) return;

    // Acha qualquer pendingCollection_${processId} ativo
    const pendingKey = Object.keys(all).find((k) => k.startsWith("pendingCollection_"));
    if (!pendingKey) return;
    const processId = pendingKey.replace("pendingCollection_", "");

    autoOpenedFromList = true;
    setCollectionProgress(processId, "Abrindo processo na lista…", 0, 4);

    // Procura o link do processo na tabela. O número está no texto, link no <a>.
    setTimeout(() => {
      if (!isContextValid()) return;
      const rows = document.querySelectorAll<HTMLTableRowElement>("table.infraTable tr");
      for (const row of rows) {
        const text = row.textContent ?? "";
        if (!text.includes(processId)) continue;

        // Acha o <a> com o número do processo (geralmente é o link primário)
        const anchors = row.querySelectorAll<HTMLAnchorElement>("a");
        for (const a of anchors) {
          if ((a.textContent ?? "").includes(processId)) {
            console.log(`[SEI Assistant] Auto-clicando no processo ${processId} da lista`);
            safeClick(a);
            return;
          }
        }
        // Fallback: clica no primeiro link da linha
        if (anchors.length > 0) {
          console.log(`[SEI Assistant] Auto-clicando (fallback) no processo ${processId}`);
          safeClick(anchors[0]);
          return;
        }
      }

      // Processo não encontrado na lista visível
      console.warn(`[SEI Assistant] Processo ${processId} não encontrado na lista do Controle de Processos`);
      setCollectionProgress(
        processId,
        `Processo ${processId} não está na lista. Abra-o manualmente no SEI.`,
        0, 4, "error",
        "Processo fora da página atual do Controle de Processos."
      );
      chrome.storage.local.remove(pendingKey);
      autoOpenedFromList = false;
    }, 500);
  });
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

  // Top frame: incorpora ao processo o conteúdo de qualquer documento visualizado
  // (inclusive abertos manualmente pelo usuário) → enriquece o resumo da IA.
  if (isTopFrame && isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area !== "local" || !isContextValid()) return;
        for (const [key, change] of Object.entries(changes)) {
          if (!key.startsWith("docContent_")) continue;
          const idDoc = key.slice("docContent_".length);
          const content = change.newValue as string | undefined;
          if (content && content.length > 80) incorporateDocContent(idDoc, content);
        }
      } catch { /* contexto invalidado — content script órfão */ }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver);
} else {
  startObserver();
}
