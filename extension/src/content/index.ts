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

function extractDocumentsFromTree(): { titles: string[]; links: Record<string, string> } {
  const seen = new Set<string>();
  const titles: string[] = [];
  const links: Record<string, string> = {};

  function addWithText(text: string, el: Element) {
    if (
      text.length > 3 &&
      !PROCESS_NUMBER_REGEX.test(text) &&
      !/^(I{1,3}|IV|V?I{0,3})$/.test(text) &&
      !/^Aguarde/i.test(text) &&
      !seen.has(text)
    ) {
      seen.add(text);
      titles.push(text);

      // Captura URL do anchor: tenta href, depois onclick
      const anchor = (el.tagName === "A" ? el : el.querySelector("a")) as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.href ?? "";
        if (href.includes("id_documento")) {
          links[text] = href;
        } else {
          const onclick = anchor.getAttribute("onclick") ?? "";
          const match = onclick.match(/controlador\.php[^'")\s]+/);
          if (match) {
            const raw = match[0];
            links[text] = raw.startsWith("http")
              ? raw
              : `${window.location.origin}/sei/${raw}`;
          }
        }
      }
    }
  }

  // Wrapper legado: useFullText determina textContent vs text-nodes diretos
  function add(el: Element, useFullText = false) {
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const full = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const text = useFullText ? (full || direct) : (direct || full);
    addWithText(text, el);
  }

  const isTreeFrame = getActionFromUrl(window.location.href) === "arvore_visualizar" ||
    document.querySelectorAll(".infraArvoreNo").length > 0;

  // Para nós da árvore: captura textContent do elemento + badge de unidade de irmãos no DOM
  // (o SEI renderiza o badge como <span> irmão de .infraArvoreNo, fora do seu textContent)
  document.querySelectorAll(".infraArvoreNo").forEach((el) => {
    let text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";

    // Procura badge de unidade em elementos irmãos (spans curtos com texto em maiúsculas)
    const parent = el.parentElement;
    if (parent) {
      for (const sib of parent.children) {
        if (sib === el) continue;
        const sibText = sib.textContent?.replace(/\s+/g, " ").trim() ?? "";
        // Badge: curto (< 40 chars), não vazio, ainda não incluído no texto base
        if (sibText.length > 0 && sibText.length < 40 && !text.includes(sibText)) {
          text = `${text} ${sibText}`;
          break;
        }
      }
    }

    addWithText(text, el);
  });

  // Salta anchors que já foram processados via .infraArvoreNo (evita duplicatas sem badge)
  document.querySelectorAll("a[href*='id_documento']").forEach((el) => {
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

// Poll para árvore SEI carregada via AJAX — tenta até 15x com intervalo de 1s
let treePoller: ReturnType<typeof setInterval> | null = null;
let treePollerAttempts = 0;
const TREE_POLL_MAX = 15;

function startTreePoller(processId: string) {
  if (treePoller) return; // já rodando
  treePoller = setInterval(() => {
    if (!isContextValid()) { clearInterval(treePoller!); treePoller = null; return; }
    treePollerAttempts++;
    const docs = document.querySelectorAll(".infraArvoreNo").length;
    console.log(`[SEI Assistant] Árvore poll #${treePollerAttempts}: ${docs} nós`);
    if (docs > 0 || treePollerAttempts >= TREE_POLL_MAX) {
      clearInterval(treePoller!);
      treePoller = null;
      treePollerAttempts = 0;
      if (docs > 0) doExtractAndSave(processId);
    }
  }, 1000);
}

function doExtractAndSave(id: string) {
  if (!isContextValid()) return;
  const storageKey = `proc_${id}`;
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

    const finalDocs = documents.length > 0 ? documents : (existing.documents ?? []);
    // Merge links: novos sobrescrevem os existentes
    const finalLinks = { ...(existing.documentLinks ?? {}), ...docLinks };

    // Invalida cache se os documentos mudaram (quantidade OU conteúdo do primeiro item)
    const existingFirst = existing.documents?.[0] ?? "";
    const newFirst = finalDocs[0] ?? "";
    const docsChanged = documents.length > 0 && (
      documents.length !== (existing.documents?.length ?? 0) ||
      newFirst !== existingFirst
    );

    const updated: ProcessDetails = {
      id,
      type: header.type ?? existing.type ?? null,
      description: header.description ?? existing.description ?? null,
      currentUnit: header.currentUnit ?? existing.currentUnit ?? null,
      parties: header.parties.length > 0 ? header.parties : (existing.parties ?? []),
      documents: finalDocs,
      documentLinks: finalLinks,
      andamento: andamento.length > 0 ? andamento : (existing.andamento ?? []),
      extractedAt: Date.now(),
      summary: docsChanged ? null : (existing.summary ?? null),
      despachosContent: docsChanged ? null : (existing.despachosContent ?? null),
    };

    // Salva mapeamento processNumber → id_procedimento (numérico interno do SEI)
    const internalId = new URL(window.location.href).searchParams.get("id_procedimento");
    if (internalId) {
      safeStorageSet({ [`procInternalId_${id}`]: internalId });
    }

    safeStorageSet({ [storageKey]: updated });
    console.log(`[SEI Assistant] Detalhes salvos para processo ${id}`, updated);
  });
}

function tryExtractAndSaveDetails() {
  const action = getActionFromUrl(window.location.href);
  const hasAndamento = !!document.querySelector("#tblHistorico");
  // Detecta frame da árvore pela URL OU pela presença dos nós —
  // o SEI usa um iframe aninhado cujo URL pode não conter acao=arvore_visualizar
  const hasTreeNodes = document.querySelectorAll(".infraArvoreNo").length > 0;
  const isTreeFrame = action === "arvore_visualizar" || hasTreeNodes;

  // Só roda em frames relevantes
  if (!hasAndamento && !hasTreeNodes && (!action || !DETAIL_ACTIONS.includes(action))) return;

  if (detailDebounce) clearTimeout(detailDebounce);
  detailDebounce = setTimeout(() => {
    const id = getCurrentProcessId();
    if (!id) return;

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

    // Outros frames: extrai andamento e metadados do header
    doExtractAndSave(id);
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
    trySaveDocUrlTemplate();

    // Captura URL do ZIP para o processo atual
    const currentId = getCurrentProcessId();
    if (currentId) trySaveZipUrl(currentId);
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
