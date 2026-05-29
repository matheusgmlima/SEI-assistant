/**
 * extension/src/background/index.ts
 *
 * Service worker — gerencia sessão, side panel e chamadas de IA.
 */

import type { ExtMessage, SessionInfo, ProcessDetails } from "@shared/index";
import {
  upsertProcesso,
  upsertDespacho,
  replaceAndamentos,
  mergeAndamentos,
  getAndamentosByProcesso,
  needsSync,
} from "../db/index";

// ─── Tipos de IA ────────────────────────────────────────────────────────────────

export interface AiConfig {
  provider: "groq" | "openai" | "custom";
  apiKey: string;
  model: string;
  baseUrl: string;
}

export const AI_PRESETS: Record<string, Omit<AiConfig, "apiKey" | "provider">> = {
  groq:   { baseUrl: "https://api.groq.com/openai/v1",  model: "llama-3.3-70b-versatile" },
  openai: { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini" },
  custom: { baseUrl: "",                                 model: "" },
};

// ─── Sessão ────────────────────────────────────────────────────────────────────

const DEFAULT_SESSION: SessionInfo = {
  status: "idle", username: null, unit: null, detectedAt: null,
};

async function clearSession() {
  await chrome.storage.local.set({ session: DEFAULT_SESSION });
}

// ─── IA ────────────────────────────────────────────────────────────────────────

function buildPrompt(details: ProcessDetails): string {
  const andamentoText =
    details.andamento.length > 0
      ? details.andamento
          .slice(0, 8)
          .map((a) => `• ${a.date} — ${a.description}${a.unit ? ` [${a.unit}]` : ""}`)
          .join("\n")
      : "Não disponível";

  const despachos = details.documents.filter((d) => /despacho/i.test(d));
  const outrosDocs = details.documents.filter((d) => !/despacho/i.test(d));
  const outrosText = outrosDocs.length > 0 ? outrosDocs.slice(0, 15).join(", ") : "Nenhum";

  const despachosText = details.despachosContent && details.despachosContent.length > 50
    ? details.despachosContent.slice(0, 6000)
    : despachos.length > 0
      ? despachos.join("\n")
      : "Nenhum despacho identificado";

  const hasRealContent = !!(details.despachosContent && details.despachosContent.length > 50);

  return `Você é um analista jurídico do TJPE. Com base nos dados do processo SEI abaixo, explique o que é este processo e seu estado atual.

NÚMERO: ${details.id}
TIPO: ${details.type ?? "Não identificado"}
ESPECIFICAÇÃO: ${details.description ?? "Não disponível"}
UNIDADE ATUAL: ${details.currentUnit ?? "Não disponível"}
INTERESSADOS: ${details.parties.join(", ") || "Não identificado"}

OUTROS DOCUMENTOS (${outrosDocs.length} total):
${outrosText}

DESPACHOS NO PROCESSO (${despachos.length} total — ${hasRealContent ? "CONTEÚDO COMPLETO" : "apenas títulos com unidade"}):
${despachosText}

ÚLTIMOS ANDAMENTOS REGISTRADOS:
${andamentoText}

${hasRealContent ? "Você possui o TEXTO COMPLETO dos despachos acima. Use-o para identificar o objeto, contratos, valores e decisões do processo." : "Os títulos dos despachos incluem a unidade responsável (ex: 'Despacho 3341475 UGP - BID'). Use isso para inferir o fluxo de tramitação."}
Responda EXATAMENTE neste formato:

**Assunto**
[O que é este processo — objeto, contrato, aquisição, etc. — em 1-3 linhas]

**Tramitação**
[Como o processo evoluiu com base nos despachos e unidades envolvidas]

**Status atual**
[Onde está agora e o que está pendente]

**Próxima ação sugerida**
[O que provavelmente precisa ser feito]`;
}

async function callAi(config: AiConfig, prompt: string): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "Você é um assistente jurídico especializado em processos administrativos do TJPE. Seja objetivo, claro e profissional. Responda sempre em português.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 900,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Erro na API (${res.status}): ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da IA.");
  return content;
}

// ─── Fetch individual de despachos ─────────────────────────────────────────────
// O background tem host_permissions para sei.cloud.tjpe.jus.br e pode fazer
// fetch com credentials: "include", usando os cookies de sessão do usuário.

interface InfraParams {
  origin: string;
  pathname: string;
  infra_hash: string | null;
  infra_sistema: string;
  infra_unidade_atual: string;
}

function extractDocumentId(title: string): string | null {
  const match = title.match(/\b(\d{5,8})\b/);
  return match?.[1] ?? null;
}

function buildDocUrl(params: InfraParams, docId: string): string {
  // Nunca inclui infra_hash — ele é de uso único e causa logout se reutilizado
  const base = params.origin + params.pathname;
  const qs = new URLSearchParams({
    acao: "documento_visualizar",
    id_documento: docId,
    infra_sistema: params.infra_sistema,
    infra_unidade_atual: params.infra_unidade_atual,
  });
  return `${base}?${qs.toString()}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOneDoc(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return "";
  const html = await res.text();

  // Extrai apenas o corpo do documento SEI, se disponível
  const bodyMatch = html.match(/<div[^>]+id=["']divConteudoVisualizacaoInterna["'][^>]*>([\s\S]*?)<\/div>/i);
  const raw = bodyMatch?.[1] ?? html;
  const text = htmlToText(raw);

  // Se o resultado parece ser uma página de login/erro (sem conteúdo útil), descarta
  if (text.length < 30 || /login|senha|acesso negado/i.test(text.slice(0, 200))) return "";
  return text;
}

async function fetchDespachosContent(
  despachoTitles: string[],
  documentLinks: Record<string, string>,
  fallbackParams: InfraParams | undefined
): Promise<string> {
  const results: string[] = [];
  let fetched = 0;

  for (const title of despachoTitles) {
    if (fetched >= 10) break; // limita a 10 despachos para não sobrecarregar

    try {
      // Tenta URL direta capturada do DOM
      let url = documentLinks[title];

      // Fallback: tenta pela base do título sem badge (ex: "Despacho 3341475 UGP-BID" → id 3341475)
      if (!url) {
        // Procura chave sem badge
        const docId = extractDocumentId(title);
        if (docId) {
          const altKey = Object.keys(documentLinks).find((k) => k.includes(docId));
          if (altKey) url = documentLinks[altKey];
        }
      }

      // Fallback: constrói URL via template (hash de documento_visualizar recente)
      if (!url && fallbackParams) {
        const docId = extractDocumentId(title);
        if (docId) url = buildDocUrl(fallbackParams, docId);
      }

      if (!url) continue;

      const text = await fetchOneDoc(url);
      if (text.length > 20) {
        results.push(`=== ${title} ===\n${text.slice(0, 1500)}`);
        fetched++;
        console.log(`[SEI Assistant] Despacho "${title.slice(0, 40)}" lido (${text.length} chars)`);
      }
    } catch {
      // ignora erros individuais
    }
  }

  console.log(`[SEI Assistant] Despachos lidos: ${fetched}/${despachoTitles.length}`);
  return results.join("\n\n");
}

// ─── Sync para IndexedDB ───────────────────────────────────────────────────────

async function syncProcessoToDB(details: ProcessDetails): Promise<void> {
  try {
    // Determina título do último despacho para sync incremental
    const despachos = details.documents.filter((d) => /^despacho\s+\d+/i.test(d));
    const ultimoDocTitulo = despachos[despachos.length - 1] ?? null;

    // Upsert processo
    await upsertProcesso({
      id: details.id,
      tipo: details.type,
      descricao: details.description,
      unidade_atual: details.currentUnit,
      partes: details.parties,
      ultimo_doc_titulo: ultimoDocTitulo,
      atualizado_em: Date.now(),
    });

    // Upsert cada despacho com id_doc extraído do título
    for (const titulo of despachos) {
      const match = titulo.match(/\b(\d{5,8})\b/);
      if (!match) continue;
      const id_doc = match[1];

      // Tenta associar data do andamento ao despacho pelo id_doc
      const andEntry = details.andamento.find((a) => a.description?.includes(id_doc));

      await upsertDespacho({
        id_doc,
        processo_id: details.id,
        titulo,
        data: andEntry?.date ?? null,
        setor: andEntry?.unit ?? null,
        conteudo: null, // preenchido depois pelo fetchDespachosContent
      });
    }

    // Merge andamentos no banco (acumula, não substitui)
    if (details.andamento.length > 0) {
      const { added, total } = await mergeAndamentos(
        details.id,
        details.andamento.map((a) => ({
          data: a.date,
          unidade: a.unit ?? "",
          descricao: a.description,
        }))
      );
      console.log(`[SEI Assistant] DB andamentos: +${added} novos | total ${total}`);
    }

    console.log(`[SEI Assistant] DB: processo ${details.id} sincronizado (${despachos.length} despachos)`);
  } catch (e) {
    console.error("[SEI Assistant] DB sync error:", e);
  }
}

// ─── Parser de andamento a partir do HTML do histórico ────────────────────────

function parseAndamentoHtml(html: string): import("@shared/index").AndamentoEntry[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Tenta #tblHistorico primeiro (padrão SEI/TJPE — confirmado pelo bot Selenium)
  let table: Element | null = doc.querySelector("#tblHistorico");

  if (!table) {
    for (const t of doc.querySelectorAll("table")) {
      const thEls   = Array.from(t.querySelectorAll("th"));
      const firstTd = Array.from(t.querySelectorAll("tr:first-child td"));
      const cands   = thEls.length > 0 ? thEls : firstTd;
      const texts   = cands.map((c) => c.textContent?.toLowerCase() ?? "");
      if (texts.some((h) => h.includes("data")) && texts.some((h) => h.includes("unidade"))) {
        table = t; break;
      }
    }
  }
  if (!table) return [];

  const thEls     = Array.from(table.querySelectorAll("th"));
  const headerEls = thEls.length > 0 ? thEls : Array.from(table.querySelectorAll("tr:first-child td"));
  const headers   = headerEls.map((el) => el.textContent?.toLowerCase().trim() ?? "");

  // Colunas do TJPE: 0=Data/Hora, 1=Unidade, 2=Usuário, 3=Descrição
  const di   = Math.max(0, headers.findIndex((h) => h.includes("data")));
  const uIdx = headers.findIndex((h) => h.includes("unidade")) >= 0
    ? headers.findIndex((h) => h.includes("unidade")) : 1;
  const xIdx = headers.findIndex((h) => h.includes("descri") || h.includes("movimento"));
  const dIdx = xIdx >= 0 ? xIdx : (headers.length >= 4 ? 3 : 1);

  const entries: import("@shared/index").AndamentoEntry[] = [];
  Array.from(table.querySelectorAll("tr")).slice(1).forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) return;
    const date        = cells[di]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const unit        = cells[uIdx]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const description = cells[dIdx]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (date || description) entries.push({ date, unit, description });
  });
  console.log(`[SEI Assistant] parseAndamentoHtml: ${entries.length} registros`);
  return entries;
}

// Extrai URL da próxima página de paginação do histórico
function extractNextPageUrl(html: string, baseUrl: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const link = doc.querySelector<HTMLAnchorElement>("#lnkInfraProximaPaginaSuperior, #lnkInfraProximaPaginaInferior");
  if (!link) return null;
  const href = link.getAttribute("href") ?? "";
  if (!href || href === "#") return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// ─── Listener de mensagens ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "SESSION_ENDED": {
      clearSession();
      sendResponse({ ok: true });
      break;
    }

    case "OPEN_DASHBOARD": {
      chrome.tabs.create({ url: "http://localhost:5173" });
      sendResponse({ ok: true });
      break;
    }

    case "SUMMARIZE_PROCESS": {
      const { processId } = message.payload as { processId: string };
      const storageKey = `proc_${processId}`;

      chrome.storage.local.get(["aiConfig", storageKey], async (result) => {
        const config = result.aiConfig as AiConfig | undefined;
        let details = result[storageKey] as ProcessDetails | undefined;

        if (!config?.apiKey) {
          sendResponse({ ok: false, error: "API key não configurada. Vá em Configurações." });
          return;
        }

        if (!details) {
          sendResponse({ ok: false, error: "Dados não disponíveis. Abra o processo no SEI primeiro." });
          return;
        }

        // NOTA: fetch automático de despachos foi removido — causava logout por CSRF.
        // O conteúdo dos despachos é extraído pelo content script quando o usuário abre o doc.

        try {
          const summary = await callAi(config, buildPrompt(details));
          const updated: ProcessDetails = { ...details, summary };
          await chrome.storage.local.set({ [storageKey]: updated });

          // Atualiza DB com conteúdo dos despachos (se disponível)
          await syncProcessoToDB(updated);

          sendResponse({ ok: true, summary });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      });

      return true; // async
    }

    case "GET_ANDAMENTO": {
      // IMPORTANTE: NÃO fazemos fetch HTTP ao SEI — causa logout por invalidação de sessão.
      // O content script extrai o andamento do DOM quando o usuário abre "Consultar Andamento".
      // Este handler apenas lê o que já foi salvo no storage pelo content script.
      const { processId } = message.payload as { processId: string };
      const storageKey = `proc_${processId}`;

      chrome.storage.local.get(storageKey, async (result) => {
        const details = result[storageKey] as ProcessDetails | undefined;

        if (!details) {
          sendResponse({ ok: false, error: "Abra o processo no SEI primeiro." });
          return;
        }

        if (!details.andamento || details.andamento.length === 0) {
          sendResponse({
            ok: false,
            error: "Abra 'Consultar Andamento' no SEI. O assistente extrai automaticamente ao carregar a página.",
          });
          return;
        }

        // Sincroniza com IndexedDB e retorna
        await syncProcessoToDB(details);
        sendResponse({ ok: true, count: details.andamento.length });
      });

      return true; // async
    }

    // Verifica se o processo precisa re-sincronizar (último despacho mudou)
    case "CHECK_SYNC": {
      const { processId, ultimoDocTitulo } = message.payload as {
        processId: string;
        ultimoDocTitulo: string | null;
      };
      needsSync(processId, ultimoDocTitulo)
        .then((needs) => sendResponse({ ok: true, needsSync: needs }))
        .catch(() => sendResponse({ ok: true, needsSync: true }));
      return true;
    }

    // Lê andamentos diretamente do IndexedDB (sem fetch)
    case "GET_DB_ANDAMENTO": {
      const { processId } = message.payload as { processId: string };
      getAndamentosByProcesso(processId)
        .then((rows) =>
          sendResponse({
            ok: true,
            andamento: rows.map((r) => ({
              date: r.data,
              unit: r.unidade,
              description: r.descricao,
            })),
          })
        )
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  }
});

// ─── Auto-sync para IndexedDB via storage.onChanged ───────────────────────────
// Sempre que o content script salvar novos andamentos no storage, sincroniza
// automaticamente para o IndexedDB sem precisar que a sidebar peça.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("proc_")) continue;
    const details = change.newValue as ProcessDetails | undefined;
    if (!details?.andamento?.length) continue;

    // Sync assíncrono — não bloqueia
    syncProcessoToDB(details).catch((e) =>
      console.error("[SEI Assistant] Auto-sync erro:", e)
    );
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await clearSession();
  console.log("[SEI Assistant] Extensão instalada e pronta.");
});
