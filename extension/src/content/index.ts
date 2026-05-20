/**
 * content/index.ts
 * Script injetado nas páginas do SEI (sei.cloud.tjpe.jus.br)
 *
 * Responsabilidades:
 * - Detectar login bem-sucedido (mudança de URL / presença de elementos pós-login)
 * - Detectar logout ou expiração de sessão
 * - Extrair dados do DOM do SEI (processos, documentos, unidade)
 * - Enviar dados para o background via chrome.runtime.sendMessage
 */

// TODO: monitorar URL para detectar sessão ativa
// TODO: extrair informações do DOM (usuário logado, unidade)
// TODO: enviar evento SESSION_DETECTED ao background
// TODO: enviar evento SESSION_ENDED ao background
