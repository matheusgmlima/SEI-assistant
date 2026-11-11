/** Lê a resposta em texto de um agente (formato definido em prompts/_comum.md). */

export type Criticidade = "ALTA" | "MÉDIA" | "BAIXA";
export interface Problema { n: number; criticidade: Criticidade; onde: string; problema: string; trechos: string[]; correcao: string }
export interface SaidaAgente { cabecalho: string; resumo: string; problemas: Problema[]; conferido: string }

export function parseSaida(texto: string): SaidaAgente {
  const linhas = texto.split("\n");
  const cabecalho = (linhas[0] ?? "").trim();
  const resumo = (linhas[1] ?? "").trim();
  const conferido = texto.match(/^\s*Conferido sem problema:\s*([\s\S]*)$/im)?.[1].trim() ?? "";
  const corpo = texto.replace(/^\s*Conferido sem problema:[\s\S]*$/im, "");
  const problemas: Problema[] = [];
  const blocos = corpo.split(/^(?=\s*\d+\.\s*\[(?:ALTA|M[ÉE]DIA|BAIXA)\])/im).slice(1);
  for (const b of blocos) {
    const h = b.match(/^\s*(\d+)\.\s*\[(ALTA|M[ÉE]DIA|BAIXA)\]\s*(.*)$/im);
    if (!h) continue;
    const campo = (nome: string) => b.match(new RegExp(`^\\s*${nome}:\\s*([\\s\\S]*?)(?=^\\s*(?:Problema|Trecho|Correção)\\b|$(?![\\s\\S]))`, "im"))?.[1].trim() ?? "";
    const trechos = [...b.matchAll(/^\s*Trecho(?:\s*\([^)]*\))?\s*:\s*("([\s\S]+?)"[ \t]*(?=\n|$)|\(ausente\))/gim)]
      .map((m) => m[2] ?? "(ausente)");
    problemas.push({
      n: Number(h[1]),
      criticidade: (h[2].toUpperCase().replace("MEDIA", "MÉDIA") as Criticidade),
      onde: h[3].trim(),
      problema: campo("Problema"),
      trechos,
      correcao: campo("Correção"),
    });
  }
  return { cabecalho, resumo, problemas, conferido };
}

/** Chave estável de um achado (para casar vereditos entre rodadas): agente + 1º trecho normalizado. */
export const chaveAchado = (agente: string, p: Pick<Problema, "trechos" | "onde">) =>
  `${agente}|${(p.trechos[0] && p.trechos[0] !== "(ausente)" ? p.trechos[0] : p.onde).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120)}`;
