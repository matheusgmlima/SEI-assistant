/**
 * extension/src/background/index.ts
 *
 * Service worker — gerencia sessão, side panel e chamadas de IA.
 */

import type { ExtMessage, SessionInfo, ProcessDetails } from "@shared/index";

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

async function fetchDespachosContent(
  despachoTitles: string[],
  params: InfraParams
): Promise<string> {
  const results: string[] = [];

  for (const title of despachoTitles) {
    const docId = extractDocumentId(title);
    if (!docId) continue;

    try {
      const url = buildDocUrl(params, docId);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) continue;

      const html = await res.text();

      // Extrai apenas o corpo do despacho via regex (sem DOMParser no SW)
      // Tenta #divConteudoVisualizacaoInterna ou fallback no body
      const innerMatch = html.match(
        /id=["']divConteudoVisualizacaoInterna["'][^>]*>([\s\S]*?)<\/div>/i
      );
      const raw = innerMatch?.[1] ?? html;

      // Remove tags HTML e normaliza espaços
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 20) {
        results.push(`=== ${title} ===\n${text.slice(0, 1500)}`);
      }
    } catch {
      // ignora erros individuais
    }
  }

  return results.join("\n\n");
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

        // Busca conteúdo dos despachos diretamente (background tem host_permission + cookies)
        const despachoTitles = details.documents.filter((d) => /despacho/i.test(d));
        if (despachoTitles.length > 0 && !details.despachosContent) {
          try {
            const stored = await chrome.storage.local.get(`infraParams_${processId}`);
            const infraParams = stored[`infraParams_${processId}`] as InfraParams | undefined;

            if (infraParams?.infra_hash) {
              const content = await fetchDespachosContent(despachoTitles, infraParams);
              if (content.length > 0) {
                details = { ...details, despachosContent: content };
                await chrome.storage.local.set({ [storageKey]: details });
              }
            }
          } catch {
            // continua sem conteúdo dos despachos
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

// ─── Init ───────────────────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await clearSession();
  console.log("[SEI Assistant] Extensão instalada e pronta.");
});
