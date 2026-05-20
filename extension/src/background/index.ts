/**
 * background/index.ts
 * Service worker da extensão (Manifest V3)
 *
 * Responsabilidades:
 * - Receber mensagens do content script (sessão detectada / encerrada)
 * - Gerenciar estado global da sessão via chrome.storage
 * - Abrir/fechar o Side Panel
 * - Comunicar-se com o dashboard via mensagens
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[SEI Assistant] Extensão instalada.");
});

// TODO: ouvir mensagens do content script
// TODO: gerenciar estado de sessão
// TODO: controlar Side Panel
