/**
 * Cliente único do LiteLLM do TJPE — usado por resumo, auditoria, perguntas,
 * agentes de revisão e controlador. As particularidades de cada modelo ficam AQUI:
 * - Opus 4.8 rejeita `temperature` (HTTP 400).
 * - Gemini "pensa" antes de responder e esses tokens contam em max_tokens:
 *   limite baixo devolve resposta VAZIA → não enviamos max_tokens para Gemini.
 */

export const LITELLM_URL = "https://litellm.cloud.tjpe.jus.br/v1";

export const MODELOS = [
  { id: "gemini-2.5-flash-br", nome: "Gemini 2.5 Flash (recomendado, ~5x mais barato)" },
  { id: "gemini-3.1-pro-preview", nome: "Gemini 3.1 Pro" },
  { id: "vertex_ai/claude-sonnet-4-6", nome: "Claude Sonnet 4.6" },
  { id: "vertex_ai/claude-opus-4-8", nome: "Claude Opus 4.8 (mais caro)" },
] as const;
// Medido no TR real (US$ por chamada ~0,065 Pro × ~0,013 Flash). Flash dá conta de resumo,
// perguntas e dos agentes guiados por ferramenta; NÃO do revisor de português (gastou todo
// o raciocínio e devolveu vazio) nem do comparador entre documentos.
export const MODELO_PADRAO = "gemini-2.5-flash-br";            // resumo, auditoria, perguntas
export const MODELO_AGENTES = "gemini-3.1-pro-preview";        // agentes de leitura fina
export const MODELO_RAPIDO = "gemini-2.5-flash-br";            // agentes guiados por ferramenta
export const MODELO_CONTROLADOR = "vertex_ai/claude-opus-4-8"; // mais rigoroso, roda pouco

export interface AiConfig { provider: "tjpe"; apiKey: string; model: string; baseUrl: string }

/** Config salva → config válida do LiteLLM, ou null (pede a chave de novo).
 *  Configs antigas de Groq/OpenAI têm chave que não serve no LiteLLM. */
export function normalizarConfig(raw: unknown): AiConfig | null {
  const c = raw as Partial<AiConfig> & { baseUrl?: string } | undefined;
  if (!c?.apiKey) return null;
  if (c.baseUrl && !/litellm\.cloud\.tjpe\.jus\.br/.test(c.baseUrl)) return null;
  const model = MODELOS.some((m) => m.id === c.model) ? c.model! : MODELO_PADRAO;
  return { provider: "tjpe", apiKey: c.apiKey, model, baseUrl: LITELLM_URL };
}

/** Config salva de outro provedor (precisa avisar o usuário para trocar a chave). */
export const configLegada = (raw: unknown) => {
  const c = raw as { apiKey?: string; baseUrl?: string } | undefined;
  return !!c?.apiKey && !!c.baseUrl && !/litellm\.cloud\.tjpe\.jus\.br/.test(c.baseUrl);
};

export interface OpcoesChat { temperature?: number; maxTokens?: number; tag?: string; tools?: unknown[] }

export function corpoChat(model: string, messages: unknown[], o: OpcoesChat = {}) {
  const b: Record<string, unknown> = { model, messages };
  if (o.temperature != null && !/opus/.test(model)) b.temperature = o.temperature;
  if (o.maxTokens != null && !/gemini/.test(model)) b.max_tokens = o.maxTokens;
  if (o.tag) b.metadata = { tags: [o.tag] }; // custo por funcionalidade na página Usage do LiteLLM
  if (o.tools?.length) b.tools = o.tools;
  return b;
}

export interface RespostaChat {
  choices: { message: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function chatCompletion(cfg: { apiKey: string; model: string; baseUrl?: string }, messages: unknown[], o: OpcoesChat = {}): Promise<RespostaChat> {
  const r = await fetch(`${(cfg.baseUrl ?? LITELLM_URL).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpoChat(cfg.model, messages, o)),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? JSON.stringify(json).slice(0, 300);
    throw new Error(r.status === 401 ? "Chave do LiteLLM inválida ou sem acesso ao modelo (401). Confira em ⚙." : `LiteLLM ${r.status}: ${msg.slice(0, 300)}`);
  }
  return json as RespostaChat;
}
