/**
 * Agente controlador: avalia os agentes com base nos vereditos dos usuários
 * (procede / falso positivo / faltou apontar) e nas violações detectadas por código,
 * propõe um prompt revisado e mede a regressão antes de qualquer mudança ser aplicada.
 * Nenhuma mudança entra sem aprovação humana.
 */
import { parseSaida } from "./saida.ts";
import type { AgenteId } from "./runner.ts";

export type TipoVeredito = "procede" | "falso_positivo" | "incerto"; // incerto = "não sei avaliar": nunca vira evidência
export interface Veredito {
  chave: string; processId: string; agente: AgenteId; veredito: TipoVeredito;
  criticidade: string; onde: string; problema: string; trecho: string; nota?: string; em: string;
}
/** Avaliação que sustenta mudança AUTOMÁTICA: acerto confirmado, ou falso alarme com motivo
 *  (sem motivo, não dá para saber se quem avaliou entendeu o achado). */
export const evidenciaUtil = (v: Veredito) => v.veredito === "procede" || (v.veredito === "falso_positivo" && !!v.nota?.trim());
export interface Falta { processId: string; agente: AgenteId; texto: string; em: string }
export interface SinalAutomatico { processId: string; agente: AgenteId; trechosNaoEncontrados: string[]; violacoes: string[] }

const PRINCIPIOS = `Você é o CONTROLADOR dos agentes de revisão documental do TJPE. Seu trabalho é melhorar o prompt de UM agente a partir de evidências: vereditos de servidores (procede / falso positivo / faltou apontar) e sinais automáticos (trecho citado que não existe no documento, desvio de formato).

Princípios de quem mantém estes agentes — siga-os:
1. Efetividade, não quantidade de regras. Zerar falso positivo E falso negativo.
2. Prefira ESTREITAR o escopo ou esclarecer uma regra existente a empilhar regra nova.
3. Erro que é de natureza mecânica (conta, contagem, presença/ausência, numeração, referência cruzada) não se corrige com prompt: diga no diagnóstico que deve virar ferramenta determinística, e não tente consertar no prompt.
4. Generalize: a regra precisa valer para qualquer TR/ETP/edital, não só para o documento do caso. Nunca cite o documento do caso nem copie seus trechos no prompt.
5. Não remova nem enfraqueça regra que sustenta achados com veredito "procede".
6. Mudança mínima: mantenha estrutura, nome do agente e seções; altere só o necessário. O formato da resposta é definido em outro arquivo comum — não o redefina.
7. Quem avalia pode não ser especialista. Julgue cada "Comentário do servidor" diante do trecho e da Lei 14.133: se o motivo for implausível (ex.: diz que não é erro algo que claramente é), DESCONSIDERE aquela avaliação e diga isso no diagnóstico. Falso alarme de criticidade ALTA só muda o prompt se o motivo for convincente.
8. Se a evidência é insuficiente ou contraditória (ex.: um único caso, vereditos divergentes), diga isso e devolva o prompt SEM mudanças.

Responda EXATAMENTE neste formato:
DIAGNÓSTICO:
- <padrão de erro identificado, com a evidência que o sustenta>
- <...>
MUDANÇAS:
- <cada alteração feita no prompt e por quê>
PROMPT REVISADO:
<<<
<o prompt completo revisado do agente>
>>>`;

export function montarPedidoMelhoria(nomeAgente: string, promptAtual: string, vereditos: Veredito[], faltas: Falta[], sinais: SinalAutomatico[]) {
  const fp = vereditos.filter((v) => v.veredito === "falso_positivo");
  const ok = vereditos.filter((v) => v.veredito === "procede");
  const lista = (vs: Veredito[]) => vs.map((v) => `- [${v.criticidade}] ${v.onde} — ${v.problema}\n  Trecho: "${v.trecho}"${v.nota ? `\n  Comentário do servidor: ${v.nota}` : ""}`).join("\n") || "(nenhum)";
  const sinaisTxt = sinais.flatMap((s) => [
    ...s.trechosNaoEncontrados.map((t) => `- Trecho citado que NÃO existe no documento: "${t.slice(0, 160)}"`),
    ...s.violacoes.map((x) => `- Desvio de formato: ${x}`),
  ]).join("\n") || "(nenhum)";
  const user = `AGENTE: ${nomeAgente}

PROMPT ATUAL:
<<<
${promptAtual}
>>>

FALSOS POSITIVOS (apontou, mas não era problema) — ${fp.length}:
${lista(fp)}

ACERTOS (apontou e procede — preservar) — ${ok.length}:
${lista(ok)}

FALTOU APONTAR (falso negativo, relatado pelo servidor) — ${faltas.length}:
${faltas.map((f) => `- ${f.texto}`).join("\n") || "(nenhum)"}

SINAIS AUTOMÁTICOS:
${sinaisTxt}`;
  return [{ role: "system", content: PRINCIPIOS }, { role: "user", content: user }];
}

export function extrairProposta(resposta: string): { diagnostico: string; mudancas: string; prompt: string | null } {
  const prompt = resposta.match(/PROMPT REVISADO:\s*<<<\s*\n?([\s\S]*?)\n?>>>/)?.[1]?.trim() ?? null;
  const diagnostico = resposta.match(/DIAGNÓSTICO:\s*([\s\S]*?)(?=\nMUDANÇAS:|\nPROMPT REVISADO:|$)/)?.[1]?.trim() ?? "";
  const mudancas = resposta.match(/MUDANÇAS:\s*([\s\S]*?)(?=\nPROMPT REVISADO:|$)/)?.[1]?.trim() ?? "";
  return { diagnostico, mudancas, prompt };
}

// ── Regressão: a nova versão ainda aponta os falsos positivos? mantém os acertos? ──
const palavras = (s: string) => new Set(s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));

/** Mesmo achado = trechos com ≥ 60% de sobreposição de palavras (ou um contém o outro). */
export function mesmoTrecho(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim(), nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (!na || !nb || na === "(ausente)" || nb === "(ausente)") return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const pa = palavras(na), pb = palavras(nb);
  const inter = [...pa].filter((w) => pb.has(w)).length;
  return inter / Math.min(pa.size || 1, pb.size || 1) >= 0.6;
}

function aindaAponta(saidaTexto: string, v: Veredito): boolean {
  const s = parseSaida(saidaTexto);
  return s.problemas.some((p) =>
    v.trecho && v.trecho !== "(ausente)"
      ? p.trechos.some((t) => mesmoTrecho(t, v.trecho))
      : p.trechos.includes("(ausente)") && mesmoTrecho(p.problema, v.problema));
}

export interface PlacarRegressao {
  falsosPositivos: { total: number; eliminados: number; persistentes: string[] };
  acertos: { total: number; mantidos: number; perdidos: string[] };
}

export function avaliarRegressao(saidaPorProcesso: Record<string, string>, vereditos: Veredito[]): PlacarRegressao {
  const placar: PlacarRegressao = { falsosPositivos: { total: 0, eliminados: 0, persistentes: [] }, acertos: { total: 0, mantidos: 0, perdidos: [] } };
  for (const v of vereditos) {
    const saida = saidaPorProcesso[v.processId];
    if (saida == null || v.veredito === "incerto") continue;
    const aponta = aindaAponta(saida, v);
    if (v.veredito === "falso_positivo") {
      placar.falsosPositivos.total++;
      if (aponta) placar.falsosPositivos.persistentes.push(`${v.onde}: ${v.problema}`); else placar.falsosPositivos.eliminados++;
    } else {
      placar.acertos.total++;
      if (aponta) placar.acertos.mantidos++; else placar.acertos.perdidos.push(`${v.onde}: ${v.problema}`);
    }
  }
  return placar;
}
