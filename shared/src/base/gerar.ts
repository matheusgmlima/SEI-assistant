/**
 * Geração de documento a partir de um modelo da caixinha: a IA adapta o modelo ao
 * processo, seção por seção, e marca cada trecho que o servidor precisa conferir/alterar
 * como {{trecho::motivo}}. O parser transforma isso em seções com partes destacadas
 * (o Word sai com os trechos em amarelo, numerados, e a lista "Pontos a conferir").
 */
import type { Modelo } from "./modelos.ts";
import { ROTULO_TIPO } from "./modelos.ts";

export interface Parte { texto: string; conferir?: { n: number; motivo: string } }
export interface SecaoGerada { titulo: string; paragrafos: Parte[][] }
export interface Rascunho { secoes: SecaoGerada[]; pontos: { n: number; trecho: string; motivo: string; secao: string }[]; pendencias: string[] }

const INSTRUCAO = (m: Modelo) => `Você prepara a BASE de um(a) ${ROTULO_TIPO[m.tipo]} para um processo do Tribunal de Justiça de Pernambuco, a partir de um ${m.natureza === "modelo_oficial" ? "MODELO OFICIAL da unidade (siga a estrutura e a redação padrão dele)" : "EXEMPLO de documento da unidade (use como inspiração de estrutura e redação)"}.

Regras:
1. Mantenha TODAS as seções do modelo, na mesma ordem e com os mesmos títulos. Não invente seção nova, salvo se o processo claramente exigir — e então marque-a inteira para conferir.
2. Adapte ao processo o que é próprio do objeto: descrição, especificações, quantidades, valores, prazos, local, unidade demandante, justificativa. Use SOMENTE informação que está nos DADOS DO PROCESSO.
3. Todo trecho que o servidor precisa conferir ou completar fica marcado assim: {{trecho::motivo curto}}
   - dado adaptado do processo que deve ser confirmado → {{30 (trinta) dias::prazo tirado do DFD, confirme}}
   - dado que o processo NÃO informa → {{[PREENCHER: valor estimado]::não consta no processo}}
   - trecho do modelo que provavelmente não se aplica a este objeto → {{texto do modelo::verificar se se aplica a este objeto}}
   O trecho dentro das chaves é o texto que fica no documento. Não use {{ }} para mais nada.
4. Redação padrão do modelo (obrigações, sanções, fiscalização, pagamento, recebimento) fica igual, sem marcação, a menos que conflite com o processo.
5. Nunca invente número de processo, CNPJ, nome de pessoa, valor ou data. Na dúvida, [PREENCHER: …] marcado.

Formato da resposta (texto puro, sem markdown, sem comentários fora deste formato):
=== <número e título da seção, como no modelo>
<parágrafos da seção, um por linha>
=== <próxima seção>
...
=== PENDÊNCIAS
- <o que o servidor precisa providenciar ou decidir antes de usar o documento, uma por linha>`;

/** Contexto do processo: o que a extensão já leu (metadados, resumo, despachos) + notas do servidor. */
export function contextoDoProcesso(p: { id: string; type?: string | null; description?: string | null; currentUnit?: string | null; parties?: string[];
  summary?: string | null; documents?: string[]; despachosContent?: string | null }, notas = ""): string {
  return [
    `Processo: ${p.id}`, p.type && `Tipo: ${p.type}`, p.description && `Especificação: ${p.description}`,
    p.currentUnit && `Unidade: ${p.currentUnit}`, p.parties?.length && `Interessados: ${p.parties.join(", ")}`,
    p.summary && `Resumo do processo:\n${p.summary}`,
    p.documents?.length && `Documentos no processo: ${p.documents.slice(0, 40).join("; ")}`,
    p.despachosContent && `Trechos dos documentos lidos:\n${p.despachosContent.slice(0, 12000)}`,
    notas.trim() && `Informações do servidor (prevalecem sobre o resto):\n${notas.trim()}`,
  ].filter(Boolean).join("\n\n");
}

export function mensagensGeracao(m: Modelo, contexto: string) {
  return [
    { role: "system", content: INSTRUCAO(m) },
    { role: "user", content: `# MODELO: ${m.titulo}\n${m.texto}\n\n# DADOS DO PROCESSO\n${contexto}` },
  ];
}

const MARCA = /\{\{([\s\S]+?)::([\s\S]*?)\}\}/g;

/** Lê a resposta da IA. Marcação malformada vira texto normal (nada se perde). */
export function lerRascunho(texto: string): Rascunho {
  const secoes: SecaoGerada[] = [];
  const pontos: Rascunho["pontos"] = [];
  const pendencias: string[] = [];
  let atual: SecaoGerada | null = null;
  let emPendencias = false;
  for (const bruta of texto.replace(/\r/g, "").split("\n")) {
    const linha = bruta.trim();
    if (!linha) continue;
    const h = linha.match(/^={3,}\s*(.+?)\s*=*$/);
    if (h) {
      emPendencias = /^pend[êe]ncias$/i.test(h[1]);
      if (!emPendencias) { atual = { titulo: h[1], paragrafos: [] }; secoes.push(atual); }
      continue;
    }
    if (emPendencias) { pendencias.push(linha.replace(/^[-•*]\s*/, "")); continue; }
    if (!atual) { atual = { titulo: "", paragrafos: [] }; secoes.push(atual); }
    const partes: Parte[] = [];
    let ultimo = 0;
    for (const mm of linha.matchAll(MARCA)) {
      if (mm.index! > ultimo) partes.push({ texto: linha.slice(ultimo, mm.index) });
      const n = pontos.length + 1;
      pontos.push({ n, trecho: mm[1].trim(), motivo: mm[2].trim(), secao: atual.titulo });
      partes.push({ texto: mm[1], conferir: { n, motivo: mm[2].trim() } });
      ultimo = mm.index! + mm[0].length;
    }
    if (ultimo < linha.length) partes.push({ texto: linha.slice(ultimo) });
    atual.paragrafos.push(partes);
  }
  return { secoes: secoes.filter((s) => s.titulo || s.paragrafos.length), pontos, pendencias };
}
