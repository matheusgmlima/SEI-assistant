/**
 * Agentes + Controlador — lógica compartilhada pela aba lateral (modo manual) e pelo
 * service worker (modo automático, disparado quando o usuário conclui uma avaliação).
 *
 * Ciclo automático por agente: evidência nova suficiente → Controlador (Opus) propõe →
 * regressão nos processos já avaliados → aplica SOZINHO só se eliminou falso alarme, não
 * perdeu nenhum acerto E quem avaliou é especialista; senão fica pendente para o dono.
 */
import { rodarAgente, AGENTES, type AgenteId, type Documento, type Prompts, type ResultadoAgente, type LlmConfig } from "@shared/agents/runner";
import { montarPedidoMelhoria, extrairProposta, avaliarRegressao, evidenciaUtil, type Veredito, type Falta, type SinalAutomatico, type PlacarRegressao } from "@shared/agents/controlador";
import { chatCompletion, normalizarConfig, MODELO_AGENTES, MODELO_RAPIDO, MODELO_CONTROLADOR } from "@shared/agents/llm";

// ── Prompts: versão do pacote + versão aprovada pelo controlador (override) ─────
const BRUTOS = import.meta.glob("../../../shared/src/agents/prompts/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const LEI = import.meta.glob("../../../shared/src/agents/conhecimento/lei14133.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const nomeArquivo = (p: string) => p.split("/").pop()!.replace(".md", "");
export const PROMPTS_BASE: Prompts = {
  comum: Object.entries(BRUTOS).find(([p]) => nomeArquivo(p) === "_comum")![1],
  lei: Object.values(LEI)[0],
  agentes: Object.fromEntries(Object.entries(BRUTOS).filter(([p]) => /^a\d/.test(nomeArquivo(p))).map(([p, t]) => [nomeArquivo(p), t])) as Record<AgenteId, string>,
};
export interface VersaoPrompt { versao: number; texto: string; em: string; motivo: string; origem?: "manual" | "auto" }
export type Overrides = Partial<Record<AgenteId, VersaoPrompt[]>>;
export const promptsAtivos = (ov: Overrides): Prompts => ({
  ...PROMPTS_BASE,
  agentes: Object.fromEntries(Object.entries(PROMPTS_BASE.agentes).map(([id, t]) => [id, ov[id as AgenteId]?.at(-1)?.texto ?? t])) as Record<AgenteId, string>,
});

// ── Storage ─────────────────────────────────────────────────────────────────────
export const sget = <T,>(k: string | null): Promise<T> => new Promise((r) => chrome.storage.local.get(k, (v) => r((k ? v[k] : v) as T)));
export const sset = (o: Record<string, unknown>) => new Promise<void>((r) => chrome.storage.local.set(o, () => r()));
export interface RevisaoSalva { em: string; modelo: string; reaproveitados?: number; documentos: { nome: string; caracteres: number }[]; resultados: ResultadoAgente[] }

export async function configLlm(papel: "agentes" | "controlador"): Promise<LlmConfig | null> {
  const c = normalizarConfig(await sget<unknown>("aiConfig"));
  if (!c) return null;
  return papel === "agentes"
    ? { baseUrl: c.baseUrl, apiKey: c.apiKey, model: MODELO_AGENTES, modelRapido: MODELO_RAPIDO }
    : { baseUrl: c.baseUrl, apiKey: c.apiKey, model: MODELO_CONTROLADOR };
}

// ── Evidência acumulada ─────────────────────────────────────────────────────────
export interface Evidencias { vereditos: Veredito[]; faltas: Falta[]; sinais: SinalAutomatico[]; overrides: Overrides; casos: Set<string> }
export async function coletarEvidencias(): Promise<Evidencias> {
  const tudo = await sget<Record<string, unknown>>(null);
  const sinais: SinalAutomatico[] = [];
  const casos = new Set<string>();
  for (const [k, v] of Object.entries(tudo)) {
    if (k.startsWith("revisaoDocs_")) casos.add(k.slice("revisaoDocs_".length));
    if (!k.startsWith("revisao_")) continue;
    for (const r of (v as RevisaoSalva).resultados ?? [])
      sinais.push({ processId: k.slice("revisao_".length), agente: r.agente, trechosNaoEncontrados: r.verificacao?.naoEncontrados ?? [], violacoes: r.violacoes ?? [] });
  }
  return { vereditos: (tudo.vereditos as Veredito[]) ?? [], faltas: (tudo.faltas as Falta[]) ?? [], sinais, overrides: (tudo.promptOverrides as Overrides) ?? {}, casos };
}

const nomeDe = (a: AgenteId) => AGENTES.find((x) => x.id === a)!.nome;

export interface Proposta { agente: AgenteId; diagnostico: string; mudancas: string; prompt: string; placar?: PlacarRegressao }

/** "só úteis": modo automático usa apenas avaliação que se sustenta (falso alarme COM motivo). */
export async function proporMelhoria(agente: AgenteId, ev: Evidencias, soUteis = false): Promise<Proposta> {
  const cfg = await configLlm("controlador");
  if (!cfg) throw new Error("Configure a chave da IA.");
  const vs = ev.vereditos.filter((v) => v.agente === agente && (soUteis ? evidenciaUtil(v) : v.veredito !== "incerto"));
  const msgs = montarPedidoMelhoria(nomeDe(agente), promptsAtivos(ev.overrides).agentes[agente], vs,
    ev.faltas.filter((f) => f.agente === agente), ev.sinais.filter((s) => s.agente === agente));
  const j = await chatCompletion(cfg, msgs, { temperature: 0, tag: "controlador" });
  const p = extrairProposta(String(j.choices?.[0]?.message?.content ?? ""));
  if (!p.prompt) throw new Error("O controlador não devolveu um prompt revisado.");
  return { agente, diagnostico: p.diagnostico, mudancas: p.mudancas, prompt: p.prompt };
}

/** Reexecuta o agente com o prompt proposto nos processos já avaliados e mede o placar. */
export async function testarProposta(p: Proposta, ev: Evidencias, progresso: (msg: string) => void = () => {}): Promise<PlacarRegressao> {
  const cfg = await configLlm("agentes");
  if (!cfg) throw new Error("Configure a chave da IA.");
  const vs = ev.vereditos.filter((v) => v.agente === p.agente && v.veredito !== "incerto");
  const casos = [...new Set(vs.map((v) => v.processId))].filter((pid) => ev.casos.has(pid));
  if (!casos.length) throw new Error("Nenhum processo salvo com avaliação para este agente — revise um processo e avalie as correções.");
  const prompts = promptsAtivos(ev.overrides);
  prompts.agentes[p.agente] = p.prompt;
  const saidas: Record<string, string> = {};
  for (const pid of casos) {
    progresso(`Testando em ${pid}…`);
    saidas[pid] = (await rodarAgente(p.agente, await sget<Documento[]>(`revisaoDocs_${pid}`), cfg, prompts)).texto;
  }
  return avaliarRegressao(saidas, vs);
}

export async function aplicarVersao(agente: AgenteId, prompt: string, motivo: string, origem: "manual" | "auto"): Promise<number> {
  const ov = (await sget<Overrides | undefined>("promptOverrides")) ?? {};
  const hist = ov[agente] ?? [];
  const versao = hist.length + 2; // v1 = versão do pacote
  await sset({ promptOverrides: { ...ov, [agente]: [...hist, { versao, texto: prompt, em: new Date().toISOString(), motivo: motivo.slice(0, 500), origem }] } });
  return versao;
}

/** Volta o agente para a versão `versao` (1 = versão do pacote). */
export async function voltarParaVersao(agente: AgenteId, versao: number) {
  const ov = (await sget<Overrides | undefined>("promptOverrides")) ?? {};
  await sset({ promptOverrides: { ...ov, [agente]: (ov[agente] ?? []).slice(0, Math.max(0, versao - 1)) } });
}

// ════════════════════════════════════════════════════════════════════════════════
// Modo automático
// ════════════════════════════════════════════════════════════════════════════════
export type TipoEvento = "aplicado" | "pendente" | "sem_mudanca" | "erro" | "descartado" | "desfeito";
export interface EventoControlador {
  id: string; em: string; agente: AgenteId; tipo: TipoEvento;
  diagnostico?: string; mudancas?: string; prompt?: string; placar?: PlacarRegressao; versao?: number; motivo?: string;
}
export interface StatusControlador { fase: string | null; em: string }

/** Freio de custo: o ciclo de um agente (Opus + regressão, ~US$ 0,20–0,50) só roda com
 *  pelo menos isto de evidência NOVA desde o último ciclo dele. */
export const MIN_EVIDENCIA_NOVA = 2;
const LOG_MAX = 40;

export async function registrarEvento(e: Omit<EventoControlador, "id" | "em">) {
  const log = (await sget<EventoControlador[] | undefined>("ctrlLog")) ?? [];
  const ev = { ...e, id: crypto.randomUUID(), em: new Date().toISOString() };
  await sset({ ctrlLog: [ev, ...log].slice(0, LOG_MAX) });
  return ev;
}
export async function marcarEvento(id: string, tipo: TipoEvento, versao?: number) {
  const log = (await sget<EventoControlador[] | undefined>("ctrlLog")) ?? [];
  await sset({ ctrlLog: log.map((e) => (e.id === id ? { ...e, tipo, ...(versao ? { versao } : {}) } : e)) });
}

/** Seguro para aplicar sem humano: eliminou ≥1 falso alarme e não perdeu acerto confirmado. */
export const regressaoSegura = (p: PlacarRegressao) => p.falsosPositivos.eliminados >= 1 && p.acertos.perdidos.length === 0;

let rodando = false;
let deNovo = false;
export async function cicloAutomatico(): Promise<void> {
  if (rodando) { deNovo = true; return; } // avaliação concluída no meio de um ciclo: roda de novo no fim
  rodando = true;
  // MV3 encerra o service worker após ~30 s sem chamada de API de extensão; uma chamada
  // ao Gemini Pro passa disso. Ping periódico mantém o ciclo vivo até terminar.
  const vivo = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  const status =(fase: string | null) => sset({ ctrlStatus: { fase, em: new Date().toISOString() } satisfies StatusControlador });
  try {
    const especialista = !!(await sget<boolean | undefined>("perfilEspecialista"));
    const marcos = (await sget<Partial<Record<AgenteId, string>> | undefined>("ctrlAuto")) ?? {};
    for (const { id: agente, nome } of AGENTES) {
      const ev = await coletarEvidencias(); // relê: um ciclo anterior pode ter aplicado versão
      const desde = marcos[agente] ?? "";
      const uteis = ev.vereditos.filter((v) => v.agente === agente && evidenciaUtil(v));
      const faltas = ev.faltas.filter((f) => f.agente === agente);
      const novas = [...uteis.filter((v) => v.em > desde), ...faltas.filter((f) => f.em > desde)];
      // só vale a pena se há algo a CORRIGIR (falso alarme justificado ou algo que faltou)
      const temCorrecao = novas.some((x) => !("veredito" in x) || x.veredito === "falso_positivo");
      if (novas.length < MIN_EVIDENCIA_NOVA || !temCorrecao) continue;
      marcos[agente] = new Date().toISOString();
      await sset({ ctrlAuto: marcos });
      try {
        await status(`Controlador analisando o ${nome}…`);
        const p = await proporMelhoria(agente, ev, true);
        if (p.prompt.trim() === promptsAtivos(ev.overrides).agentes[agente].trim()) {
          await registrarEvento({ agente, tipo: "sem_mudanca", diagnostico: p.diagnostico });
          continue;
        }
        await status(`Testando a melhoria do ${nome} nos processos já avaliados…`);
        p.placar = await testarProposta(p, ev, (m) => status(`${nome}: ${m}`));
        if (regressaoSegura(p.placar) && especialista) {
          const versao = await aplicarVersao(agente, p.prompt, p.mudancas, "auto");
          await registrarEvento({ agente, tipo: "aplicado", diagnostico: p.diagnostico, mudancas: p.mudancas, placar: p.placar, versao });
        } else {
          await registrarEvento({ agente, tipo: "pendente", diagnostico: p.diagnostico, mudancas: p.mudancas, prompt: p.prompt, placar: p.placar,
            motivo: !regressaoSegura(p.placar)
              ? (p.placar.acertos.perdidos.length ? "o teste perdeu um acerto confirmado" : "o teste não eliminou nenhum falso alarme")
              : "as avaliações não são de um especialista (⚙ Configurações)" });
        }
      } catch (e) {
        await registrarEvento({ agente, tipo: "erro", diagnostico: String((e as Error)?.message ?? e) });
      }
    }
  } finally {
    clearInterval(vivo);
    await status(null);
    rodando = false;
    if (deNovo) { deNovo = false; void cicloAutomatico(); }
  }
}
