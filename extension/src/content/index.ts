/**
 * extension/src/content/index.ts
 *
 * Injetado em todas as páginas do SEI.
 * Detecta login/logout e extrai dados básicos do DOM para enviar ao background.
 */

import type { SessionInfo } from "@shared/index";

// Ações do SEI que indicam sessão ativa (pós-login)
const AUTHENTICATED_ACTIONS = [
  "principal",
  "arvore_visualizar",
  "processo_visualizar",
  "documento_visualizar",
  "controlador_ajax",
];

// Elemento presente apenas no SEI logado
const SESSION_ANCHOR_SELECTOR = "#divInfraBarraSistema";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function getActionFromUrl(url: string): string | null {
  try {
    const params = new URL(url).searchParams;
    return params.get("acao");
  } catch {
    return null;
  }
}

function isAuthenticated(): boolean {
  const action = getActionFromUrl(window.location.href);
  const hasAnchor = !!document.querySelector(SESSION_ANCHOR_SELECTOR);
  return hasAnchor || (action !== null && AUTHENTICATED_ACTIONS.includes(action));
}

/**
 * Extrai nome do usuário e unidade diretamente do DOM do SEI.
 * O SEI exibe no topo direito: "COORD. AQUISIÇÕES - BID"
 */
function extractSessionInfo(): Pick<SessionInfo, "username" | "unit"> {
  const unitEl = document.querySelector("#lnkInfraUnidade, .infraBarraUsuario");
  const unit = unitEl?.textContent?.trim() ?? null;

  const userEl = document.querySelector("#txaInfraUsuario, [id*='Usuario']");
  const username = userEl?.textContent?.trim() ?? null;

  return { username, unit };
}

// ─────────────────────────────────────────
// Escrita direta no storage
// Não depende do service worker estar ativo (MV3 dorme após 30s)
// ─────────────────────────────────────────

function notifySessionDetected() {
  const { username, unit } = extractSessionInfo();

  const session: SessionInfo = {
    status: "detected",
    username,
    unit,
    detectedAt: Date.now(),
  };

  chrome.storage.local.set({ session });
}

function notifySessionEnded() {
  const session: SessionInfo = {
    status: "idle",
    username: null,
    unit: null,
    detectedAt: null,
  };

  chrome.storage.local.set({ session });
}

// ─────────────────────────────────────────
// Observador de navegação
// O SEI usa iframes e hash routing sem full reload,
// então monitoramos via MutationObserver + popstate
// ─────────────────────────────────────────

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
}

function startObserver() {
  checkAndNotify();

  // Se já está autenticado ao carregar, re-notifica após 1s
  // para garantir que o background recebeu (service worker pode estar iniciando)
  setTimeout(() => {
    if (isAuthenticated()) notifySessionDetected();
  }, 1000);

  // Monitorar mudanças no DOM (navegação por iframes)
  const observer = new MutationObserver(() => {
    checkAndNotify();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Monitorar navegação via history API
  window.addEventListener("popstate", checkAndNotify);
}

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver);
} else {
  startObserver();
}
