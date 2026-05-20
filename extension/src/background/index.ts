/**
 * extension/src/background/index.ts
 *
 * Service worker — orquestra o estado da sessão e controla o Side Panel.
 */

import type { ExtMessage, SessionInfo } from "@shared/index";

// Estado inicial da sessão
const DEFAULT_SESSION: SessionInfo = {
  status: "idle",
  username: null,
  unit: null,
  detectedAt: null,
};

// ─────────────────────────────────────────
// Persistência via chrome.storage.local
// ─────────────────────────────────────────

async function saveSession(session: SessionInfo) {
  await chrome.storage.local.set({ session });
}

async function clearSession() {
  await chrome.storage.local.set({ session: DEFAULT_SESSION });
}

// ─────────────────────────────────────────
// Listener de mensagens (content script → background)
// ─────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, sender, sendResponse) => {
    switch (message.type) {
      case "SESSION_DETECTED": {
        const session = message.payload as SessionInfo;
        saveSession(session);
        sendResponse({ ok: true });
        break;
      }

      case "SESSION_ENDED": {
        clearSession();
        sendResponse({ ok: true });
        break;
      }

      case "GET_SESSION": {
        chrome.storage.local.get("session", (result) => {
          sendResponse(result.session ?? DEFAULT_SESSION);
        });
        return true; // mantém canal aberto para resposta assíncrona
      }

      case "OPEN_DASHBOARD": {
        chrome.tabs.create({ url: "http://localhost:5173" });
        sendResponse({ ok: true });
        break;
      }
    }
  }
);

// ─────────────────────────────────────────
// Init
// Chrome não permite sidePanel.open() sem gesto do usuário.
// setPanelBehavior garante que o painel abre ao clicar no ícone da extensão.
// ─────────────────────────────────────────

// Roda toda vez que o service worker inicializa
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await clearSession();
  console.log("[SEI Assistant] Extensão instalada e pronta.");
});
