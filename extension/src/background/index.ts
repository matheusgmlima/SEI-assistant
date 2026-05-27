/**
 * extension/src/background/index.ts
 *
 * Service worker — gerencia sessão, side panel e chamadas de IA.
 */

import type { ExtMessage, SessionInfo, ProcessDetails } from "@shared/index";
import JSZip from "jszip";

// ─── Tipos de IA ────────────────────────────────────────────────────────────────

export interface AiConfig {
  provider: "groq" | "openai" | "custom";
  apiKey: string;
  model: string;
  baseUrl: string;
}

// Presets por provider — todos usam formato OpenAI-compatible
export const AI_PRESETS: Record<string, Omit<AiConfig, "apiKey" | "provider">> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  custom: {
    baseUrl: "",
    model: "",
  },
};

// ─── Sessão ────────────────────────────────────────────────────────────────────

const DEFAULT_SESSION: SessionInfo = {
  status: "idle",
  username: null,
  unit: null,
  detectedAt: null,
};

async function clearSession() {
  await chrome.storage.local.set({ session: DEFAULT_SESSION });
}

// ─── IA — chamada genérica OpenAI-compatible ────────────────────────────────────

function buildPrompt(details: ProcessDetails): string {
  const andamentoText =
    details.andamento.length > 0
      ? details.andamento
          .slice(0, 8)
          .map((a) => `• ${a.date} — ${a.description}${a.unit ? ` [${a.unit}]` : ""}`)
          .join("\n")
      : "Não disponível";

  // Separa despachos dos demais documentos
  const despachos = details.documents.filter((d) => /despacho/i.test(d));
  const outrosDocs = details.documents.filter((d) => !/despacho/i.test(d));

  const outrosText =
    outrosDocs.length > 0
      ? outrosDocs.slice(0, 15).join(", ")
      : "Nenhum";

  // Usa conteúdo real dos despachos se disponível; senão, apenas os títulos
  const despachosText = details.despachosContent && details.despachosContent.length > 50
    ? details.despachosContent.slice(0, 6000) // limita tokens
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

DESPACHOS NO PROCESSO (${despachos.length} total — ${hasRealContent ? "CONTEÚDO COMPLETO" : "apenas títulos"}):
${despachosText}

ÚLTIMOS ANDAMENTOS REGISTRADOS:
${andamentoText}

${hasRealContent ? "Você possui o TEXTO COMPLETO dos despachos acima. Use-o para identificar o objeto, contratos, valores e decisões do processo." : "Use os nomes dos documentos e despachos como pistas sobre o objeto e tramitação do processo."}
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
          content:
            "Você é um assistente jurídico especializado em processos administrativos do TJPE. Seja objetivo, claro e profissional. Responda sempre em português.",
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

// ─── Fetch de despachos (background tem host_permission, inclui cookies) ────────

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
  const base = params.origin + params.pathname;
  const qs = new URLSearchParams({
    acao: "documento_visualizar",
    id_documento: docId,
    infra_sistema: params.infra_sistema,
    infra_unidade_atual: params.infra_unidade_atual,
    ...(params.infra_hash ? { infra_hash: params.infra_hash } : {}),
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

  // Tenta extrair apenas o corpo do despacho
  const bodyMatch = html.match(/<div[^>]+id=["']divConteudoVisualizacaoInterna["'][^>]*>([\s\S]*?)<\/div>/i);
  const raw = bodyMatch?.[1] ?? html;
  return htmlToText(raw);
}

async function fetchDespachosContent(
  despachoTitles: string[],
  documentLinks: Record<string, string>,
  fallbackParams: InfraParams | undefined
): Promise<string> {
  const results: string[] = [];

  for (const title of despachoTitles) {
    try {
      let url = documentLinks[title];

      // Fallback: constrói URL com template salvo + ID do título
      if (!url && fallbackParams) {
        const docId = extractDocumentId(title);
        if (docId) url = buildDocUrl(fallbackParams, docId);
      }

      if (!url) continue;

      const text = await fetchOneDoc(url);
      if (text.length > 20) {
        results.push(`=== ${title} ===\n${text.slice(0, 1500)}`);
      }
    } catch {
      // ignora erros individuais
    }
  }

  return results.join("\n\n");
}

// ─── ZIP do processo ────────────────────────────────────────────────────────────

interface ZipExtract {
  despachosContent: string;
  andamentoText: string;
}

async function parseZipBuffer(buffer: ArrayBuffer): Promise<ZipExtract> {
  const zip = await JSZip.loadAsync(buffer);

  const despachoChunks: string[] = [];
  let andamentoText = "";

  for (const [filename, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const lower = filename.toLowerCase();
    if (!lower.endsWith(".html") && !lower.endsWith(".htm")) continue;

    const html = await file.async("string");
    const text = htmlToText(html).slice(0, 3000);
    if (text.length < 20) continue;

    if (/despacho/i.test(filename)) {
      despachoChunks.push(`=== ${filename} ===\n${text}`);
    } else if (/andamento|historico/i.test(filename)) {
      andamentoText = text;
    }
  }

  return { despachosContent: despachoChunks.join("\n\n"), andamentoText };
}

// Estratégia: busca procedimento_gerar_zip (gera ZIP fresco no servidor) e processa o binário.
// O servidor pode retornar redirect HTTP → ZIP binário, ou HTML contendo link para exibir_arquivo.
async function fetchZipFromGenerationUrl(genUrl: string): Promise<ZipExtract> {
  const res = await fetch(genUrl, { credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error(`Geração ZIP falhou: ${res.status}`);

  const ct = res.headers.get("content-type") ?? "";

  // Caso 1: servidor retornou binário diretamente (após redirect HTTP)
  if (ct.includes("zip") || ct.includes("octet-stream") || ct.includes("x-zip")) {
    return parseZipBuffer(await res.arrayBuffer());
  }

  // Caso 2: servidor retornou HTML — extrai URL de exibir_arquivo e busca o binário
  const html = await res.text();
  const candidates = [
    ...(html.match(/['"]([^'"]*exibir_arquivo[^'"]*)['"]/g) ?? []),
    ...(html.match(/href=([^\s>]+exibir_arquivo[^\s>]*)/g) ?? []),
  ];

  for (const raw of candidates) {
    try {
      let urlStr = raw.replace(/^['"]|['"]$/g, "").replace(/^href=/, "").replace(/&amp;/g, "&");
      const fileUrl = urlStr.startsWith("http") ? urlStr : new URL(urlStr, genUrl).href;
      const fileRes = await fetch(fileUrl, { credentials: "include" });
      if (!fileRes.ok) continue;
      const buffer = await fileRes.arrayBuffer();
      // Verifica assinatura ZIP (PK\x03\x04)
      const magic = new Uint8Array(buffer, 0, 4);
      if (magic[0] === 0x50 && magic[1] === 0x4b) {
        console.log("[SEI Assistant] ZIP binário obtido via HTML redirect:", fileUrl.slice(0, 80));
        return parseZipBuffer(buffer);
      }
    } catch { /* tenta próximo candidato */ }
  }

  throw new Error(`ZIP não encontrado. content-type: ${ct}`);
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
          sendResponse({
            ok: false,
            error: "Dados não disponíveis. Abra o processo no SEI primeiro.",
          });
          return;
        }

        // Tenta ZIP interceptado primeiro (URL com hash correto capturada via webRequest)
        if (!details.despachosContent) {
          try {
            // Busca o id_procedimento interno para localizar a URL do ZIP
            const idStored = await chrome.storage.local.get(`procInternalId_${processId}`);
            const internalId = idStored[`procInternalId_${processId}`] as string | undefined;
            const zipKey = internalId ? `zipUrlById_${internalId}` : null;
            const zipStored = zipKey ? await chrome.storage.local.get(zipKey) : {};
            const zipUrl = zipKey ? zipStored[zipKey] as string | undefined : undefined;

            if (zipUrl) {
              console.log(`[SEI Assistant] Baixando ZIP do processo (URL interceptada)...`);
              const { despachosContent } = await fetchAndParseZip(zipUrl);
              if (despachosContent.length > 0) {
                details = { ...details, despachosContent };
                await chrome.storage.local.set({ [storageKey]: details });
                console.log(`[SEI Assistant] ZIP processado: ${despachosContent.length} chars`);
              }
            } else {
              console.log(`[SEI Assistant] ZIP não disponível ainda. Clique no ícone ZIP no SEI para ativar.`);
              // Fallback: busca despachos individuais pelos links capturados
              const despachoTitles = details.documents.filter((d) => /despacho/i.test(d));
              if (despachoTitles.length > 0) {
                const stored = await chrome.storage.local.get("docUrlTemplate");
                const fallbackParams = stored["docUrlTemplate"] as InfraParams | undefined;
                const docLinks = details.documentLinks ?? {};
                const content = await fetchDespachosContent(despachoTitles, docLinks, fallbackParams);
                if (content.length > 0) {
                  details = { ...details, despachosContent: content };
                  await chrome.storage.local.set({ [storageKey]: details });
                }
              }
            }
          } catch (e) {
            console.error("[SEI Assistant] Erro ao buscar conteúdo:", e);
          }
        }

        try {
          const summary = await callAi(config, buildPrompt(details));
          const updated: ProcessDetails = { ...details, summary };
          await chrome.storage.local.set({ [storageKey]: updated });
          sendResponse({ ok: true, summary });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      });

      return true; // async
    }
  }
});

// ─── Intercepta ZIP e baixa imediatamente ──────────────────────────────────────
// O SEI funciona assim:
//   1. Browser requisita procedimento_gerar_zip → servidor gera o ZIP, temp file
//   2. Browser requisita exibir_arquivo → servidor serve o binário .zip
// O arquivo temporário existe apenas enquanto o browser o está baixando.
// Solução: quando exibir_arquivo é interceptado, baixar o ZIP imediatamente
// em paralelo com o browser — antes que o arquivo seja deletado.

const zipPendingByProc = new Map<string, number>(); // idProc → timestamp

// Busca o número do processo (ex: "00030695-05.2025.8.17.8017") a partir do id_procedimento numérico
async function procKeyFromInternalId(internalId: string): Promise<string | null> {
  const all = await chrome.storage.local.get(null);
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith("procInternalId_") && val === internalId) {
      return `proc_${key.replace("procInternalId_", "")}`;
    }
  }
  return null;
}

async function fetchAndStoreZipImmediate(internalId: string, zipUrl: string) {
  try {
    const procKey = await procKeyFromInternalId(internalId);
    if (!procKey) {
      console.log("[SEI Assistant] Processo não mapeado para idProc:", internalId);
      return;
    }

    console.log("[SEI Assistant] Baixando ZIP imediatamente:", zipUrl.slice(0, 100));
    const { despachosContent } = await fetchAndParseZip(zipUrl);
    if (despachosContent.length === 0) {
      console.log("[SEI Assistant] ZIP sem despachos.");
      return;
    }

    const stored = await chrome.storage.local.get(procKey);
    const existing = stored[procKey] as ProcessDetails | undefined;
    if (existing) {
      await chrome.storage.local.set({ [procKey]: { ...existing, despachosContent } });
      console.log(`[SEI Assistant] ZIP salvo em ${procKey}: ${despachosContent.length} chars`);
    }
  } catch (e) {
    console.error("[SEI Assistant] Erro ao baixar ZIP imediato:", e);
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const acao = url.searchParams.get("acao") ?? "";

      // Passo 1: geração do ZIP — marca pendente
      if (acao === "procedimento_gerar_zip" || acao === "arquivo_gerar_zip") {
        const idProc = url.searchParams.get("id_procedimento");
        if (!idProc) return;
        zipPendingByProc.set(idProc, Date.now());
        console.log("[SEI Assistant] ZIP solicitado, idProc:", idProc);
        return;
      }

      // Passo 2: binário disponível — baixa IMEDIATAMENTE em paralelo com o browser
      if (acao === "exibir_arquivo") {
        const now = Date.now();
        for (const [idProc, ts] of zipPendingByProc.entries()) {
          if (now - ts < 15000) {
            zipPendingByProc.delete(idProc);
            // Não aguarda — dispara em background sem bloquear o listener
            fetchAndStoreZipImmediate(idProc, details.url);
            return;
          }
        }
        // Limpa entradas antigas
        for (const [idProc, ts] of zipPendingByProc.entries()) {
          if (now - ts >= 15000) zipPendingByProc.delete(idProc);
        }
      }
    } catch { /* ignore */ }
  },
  { urls: ["https://sei.cloud.tjpe.jus.br/*"], types: ["main_frame", "sub_frame", "xmlhttprequest"] },
  []
);

// ─── Init ───────────────────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await clearSession();
  console.log("[SEI Assistant] Extensão instalada e pronta.");
});
