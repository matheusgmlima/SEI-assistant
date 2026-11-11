/**
 * Orquestra os agentes de revisão: monta a instrução, PRÉ-executa as ferramentas
 * de texto (resultado entra como evidência — não depende do modelo decidir chamar),
 * expõe as ferramentas com argumento via function calling, e confere se cada
 * "Trecho" citado existe de fato no documento.
 * Sem dependência de ambiente: os textos dos prompts são injetados por quem chama
 * (Vite ?raw na extensão, fs nos scripts).
 */
import * as T from "./tools.ts";
const { semSumario } = T;

export type AgenteId = "a1-revisor" | "a2-consistencia" | "a3-conformidade" | "a4-estrutura" | "a5-dados" | "a6-inconsistencias";
export interface Documento { nome: string; texto: string }
export interface Prompts { comum: string; lei: string; agentes: Record<AgenteId, string> }
export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

interface Agente {
  id: AgenteId;
  nome: string;
  usaLei: boolean;
  multiDoc: boolean; // precisa de 2+ documentos
  preTools: (texto: string) => Record<string, unknown>;
  fnTools: (keyof typeof FN)[];
}

export const AGENTES: Agente[] = [
  { id: "a1-revisor", nome: "Revisor Linguístico e Editorial", usaLei: false, multiDoc: false,
    preTools: (t) => {
      const r = T.verificar_referencias_cruzadas(t);
      return { verificar_numeracao_sequencial: T.verificar_numeracao_sequencial(t),
        verificar_referencias_cruzadas: { referencias_citadas: r.referencias_citadas, referencias_quebradas: r.referencias_quebradas } };
    }, fnTools: ["verificar_total_calculado"] },
  { id: "a2-consistencia", nome: "Validador de Consistência Documental", usaLei: false, multiDoc: true,
    preTools: (t) => {
      const c = T.verificar_clausulas_obrigatorias(t);
      return { extrair_prazos_do_texto: T.extrair_prazos_do_texto(t),
        verificar_clausulas_obrigatorias: { garantias: c.garantias, subcontratacao: c.subcontratacao, penalidades_sancoes: c.penalidades_sancoes } };
    }, fnTools: ["comparar_valores_monetarios"] },
  { id: "a3-conformidade", nome: "Auditor de Conformidade Legal", usaLei: true, multiDoc: false,
    preTools: (t) => ({ verificar_clausulas_obrigatorias: T.verificar_clausulas_obrigatorias(t),
      verificar_detalhamento_sancoes: T.verificar_detalhamento_sancoes(t) }), fnTools: [] },
  { id: "a4-estrutura", nome: "Fiscal de Estrutura Documental", usaLei: true, multiDoc: false,
    preTools: (t) => ({ listar_secoes_do_documento: T.listar_secoes_do_documento(t) }), fnTools: [] },
  { id: "a5-dados", nome: "Validador de Dados Institucionais", usaLei: false, multiDoc: false,
    preTools: (t) => ({ extrair_dados_institucionais: T.extrair_dados_institucionais(t) }), fnTools: ["validar_cnpj", "validar_cep"] },
  { id: "a6-inconsistencias", nome: "Detector de Inconsistências Internas", usaLei: false, multiDoc: false,
    preTools: (t) => ({ extrair_mencoes_numericas_temporais: T.extrair_mencoes_numericas_temporais(t) }), fnTools: [] },
];

// ── Ferramentas chamáveis (function calling) ────────────────────────────────────
const str = (description: string) => ({ type: "string", description });
const FN = {
  verificar_total_calculado: {
    fn: (a: Record<string, string>) => T.verificar_total_calculado(a.valor_unitario, a.quantidade, a.valor_total_declarado),
    desc: "Confere se valor_unitario × quantidade = valor_total_declarado (formato brasileiro, ex.: \"R$ 585,00\").",
    params: { valor_unitario: str("ex.: R$ 585,00"), quantidade: str("ex.: 10"), valor_total_declarado: str("ex.: R$ 5.850,00") },
  },
  comparar_valores_monetarios: {
    fn: (a: Record<string, string>) => T.comparar_valores_monetarios(a.valor1, a.valor2),
    desc: "Normaliza dois valores monetários brasileiros e diz se são iguais e a diferença.",
    params: { valor1: str("valor no documento 1"), valor2: str("valor no documento 2") },
  },
  validar_cnpj: {
    fn: (a: Record<string, string>) => T.validar_cnpj(a.cnpj),
    desc: "Valida formato e dígitos verificadores de um CNPJ.",
    params: { cnpj: str("CNPJ com ou sem máscara") },
  },
  validar_cep: {
    fn: (a: Record<string, string>) => T.validar_cep(a.cep, a.endereco_esperado ?? ""),
    desc: "Valida o formato do CEP e consulta o ViaCEP para conferir o endereço/cidade.",
    params: { cep: str("CEP"), endereco_esperado: str("cidade ou trecho de endereço citado junto do CEP (opcional)") },
  },
} as const;

const toolDefs = (nomes: (keyof typeof FN)[]) => nomes.map((n) => ({
  type: "function",
  function: { name: n, description: FN[n].desc,
    parameters: { type: "object", properties: FN[n].params, required: Object.keys(FN[n].params).filter((k) => k !== "endereco_esperado") } },
}));

// ── Montagem da instrução ───────────────────────────────────────────────────────
export function montarMensagens(agente: Agente, prompts: Prompts, docs: Documento[]) {
  const system = [prompts.comum, prompts.agentes[agente.id], agente.usaLei ? `# BASE DE CONHECIMENTO\n${prompts.lei}` : ""]
    .filter(Boolean).join("\n\n");
  const ferramentas = docs.map((d) => ({ documento: d.nome, ...agente.preTools(semSumario(d.texto)) }));
  const user = [
    `# RESULTADO DAS FERRAMENTAS (já executadas)\n${JSON.stringify(docs.length === 1 ? ferramentas[0] : ferramentas)}`,
    ...docs.map((d) => `# DOCUMENTO: ${d.nome}\n${d.texto}`),
  ].join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ── Chamada ao modelo com laço de function calling ──────────────────────────────
type Msg = { role: string; content: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

async function chamar(cfg: LlmConfig, messages: Msg[], tools: unknown[], tag: string) {
  const body: Record<string, unknown> = { model: cfg.model, messages, metadata: { tags: [tag] } };
  if (tools.length) body.tools = tools;
  if (!/opus/.test(cfg.model)) body.temperature = 0; // Opus 4.8 rejeita temperature
  const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`LiteLLM ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json as { choices: { message: Msg }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
}

export interface ResultadoAgente {
  agente: AgenteId; nome: string; texto: string; ms: number;
  tokens: { entrada: number; saida: number };
  chamadasFerramenta: string[];
  verificacao: VerificacaoTrechos;
  violacoes: string[]; // desvios de formato corrigidos/detectados por código
}

// Ferramenta de validação só aceita dado que ESTÁ ESCRITO no documento —
// impede o modelo de "achar" um CEP/CNPJ por conta própria e contestar o documento.
function guardaArgumento(nome: string, a: Record<string, string>, docs: Documento[]): string | null {
  const campo = nome === "validar_cep" ? a.cep : nome === "validar_cnpj" ? a.cnpj : null;
  if (campo == null) return null;
  const dig = String(campo).replace(/\D/g, "");
  // "50.010-240", "11.222.333/0001-81" → só dígitos, mantendo a fronteira com o resto do texto
  const corpus = docs.map((d) => d.texto).join(" ").replace(/(\d)[.\/-]\s?(?=\d)/g, "$1");
  return dig && new RegExp(`(^|\\D)${dig}(\\D|$)`).test(corpus)
    ? null
    : `${nome === "validar_cep" ? "CEP" : "CNPJ"} ${campo} não está escrito no documento — só valide dados extraídos do texto.`;
}

/** Remove texto antes do cabeçalho e marcadores proibidos; registra o que corrigiu. */
export function limparSaida(bruto: string, nome: string): { texto: string; violacoes: string[] } {
  const violacoes: string[] = [];
  let t = bruto.trim();
  const i = t.indexOf(nome);
  if (i > 0) { violacoes.push(`texto antes do cabeçalho: "${t.slice(0, i).trim().slice(0, 120)}"`); t = t.slice(i); }
  if (i < 0) violacoes.push("cabeçalho com o nome do agente ausente");
  if (/^\s*[{[]/.test(t)) violacoes.push("resposta em JSON");
  if (/^#{1,3}\s|\*\*/m.test(t)) { violacoes.push("markdown na resposta"); t = t.replace(/\*\*/g, "").replace(/^#{1,3}\s*/gm, ""); }
  return { texto: t, violacoes };
}

export async function rodarAgente(id: AgenteId, docs: Documento[], cfg: LlmConfig, prompts: Prompts): Promise<ResultadoAgente> {
  const agente = AGENTES.find((a) => a.id === id)!;
  const messages: Msg[] = montarMensagens(agente, prompts, docs);
  const tools = toolDefs(agente.fnTools);
  const t0 = Date.now();
  const tokens = { entrada: 0, saida: 0 };
  const chamadas: string[] = [];
  for (let rodada = 0; rodada < 8; rodada++) {
    const res = await chamar(cfg, messages, tools, `agente-${id}`);
    tokens.entrada += res.usage?.prompt_tokens ?? 0;
    tokens.saida += res.usage?.completion_tokens ?? 0;
    const msg = res.choices[0].message;
    if (!msg.tool_calls?.length) {
      const { texto, violacoes } = limparSaida(String(msg.content ?? ""), agente.nome);
      return { agente: id, nome: agente.nome, texto, ms: Date.now() - t0, tokens, chamadasFerramenta: chamadas,
        verificacao: verificarTrechos(texto, docs), violacoes };
    }
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      const def = FN[tc.function.name as keyof typeof FN];
      let out: unknown;
      try {
        const a = JSON.parse(tc.function.arguments || "{}");
        const recusa = guardaArgumento(tc.function.name, a, docs);
        out = recusa ? { erro: recusa } : def ? await def.fn(a) : { erro: "ferramenta inexistente" };
      } catch (e) { out = { erro: String(e) }; }
      chamadas.push(`${tc.function.name}(${tc.function.arguments})`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
    }
  }
  throw new Error(`${id}: excedeu o limite de rodadas de ferramenta`);
}

export function agentesAplicaveis(docs: Documento[]): AgenteId[] {
  return AGENTES.filter((a) => !a.multiDoc || docs.length >= 2).map((a) => a.id);
}

// ── Verificação dos trechos citados (anti-alucinação) ───────────────────────────
export interface VerificacaoTrechos { total: number; verificados: number; naoEncontrados: string[] }

const norm = (s: string) => s
  .normalize("NFC").toLowerCase()
  .replace(/[“”«»"]/g, "").replace(/[‘’`']/g, "'").replace(/[–—]/g, "-")
  .replace(/(\p{Ll})-\s+(\p{Ll})/gu, "$1$2")
  .replace(/\s+/g, " ").trim();

export function verificarTrechos(saida: string, docs: Documento[]): VerificacaoTrechos {
  const corpus = norm(docs.map((d) => d.texto).join("\n"));
  const porDoc = new Map(docs.map((d) => [norm(d.nome), norm(d.texto)]));
  const naoEncontrados: string[] = [];
  let total = 0;
  // Trecho pode quebrar linha: vai da aspa de abertura até a aspa de fechamento no fim de linha.
  for (const m of saida.matchAll(/^\s*Trecho(?:\s*\(([^)]*)\))?\s*:\s*"([\s\S]+?)"[ \t]*(?=\n|$)/gim)) {
    total++;
    const alvo = (m[1] && [...porDoc].find(([k]) => k.includes(norm(m[1])) || norm(m[1]).includes(k))?.[1]) || corpus;
    // Trecho com reticências: cada pedaço (≥ 3 palavras) precisa existir.
    // Pedaços curtos demais entre reticências são ignorados; trecho curto SEM reticências
    // (telefone, CEP, nº de processo) é conferido inteiro.
    const partes = m[2].split(/\.{3}|…/).map(norm).filter(Boolean);
    const pedacos = partes.length === 1 ? partes : partes.filter((p) => p.split(" ").length >= 3 || p.length >= 12);
    if (!pedacos.length || !pedacos.every((p) => alvo.includes(p))) naoEncontrados.push(m[2]);
  }
  return { total, verificados: total - naoEncontrados.length, naoEncontrados };
}
export const __test = { guardaArgumento };
