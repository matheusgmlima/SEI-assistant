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
          .slice(0, 6)
          .map((a) => `• ${a.date} — ${a.description}${a.unit ? ` [${a.unit}]` : ""}`)
          .join("\n")
      : "Não disponível";

  const documentsText =
    details.documents.length > 0
      ? details.documents.slice(0, 10).join(", ")
      : "Não disponível";

  return `Analise o processo administrativo do SEI/TJPE abaixo e forneça um resumo estruturado em português:

NÚMERO: ${details.id}
TIPO: ${details.type ?? "Não identificado"}
ESPECIFICAÇÃO: ${details.description ?? "Não disponível"}
UNIDADE ATUAL: ${details.currentUnit ?? "Não disponível"}
INTERESSADOS: ${details.parties.join(", ") || "Não identificado"}
DOCUMENTOS: ${documentsText}

ÚLTIMOS ANDAMENTOS:
${andamentoText}

Responda EXATAMENTE neste formato:

**Assunto**
[1-2 linhas explicando do que trata o processo]

**Último despacho**
[O que foi decidido/informado mais recentemente, com data se disponível]

**Status atual**
[Situação atual e onde o processo está parado]

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
      max_tokens: 700,
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
        const details = result[storageKey] as ProcessDetails | undefined;

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

        try {
          const summary = await callAi(config, buildPrompt(details));
          // Cacheia o resumo junto com os detalhes
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
