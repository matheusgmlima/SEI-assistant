// Checagens determinísticas do runner (sem chamar modelo). Uso: node shared/scripts/runner-check.mjs
import assert from "node:assert/strict";
import { verificarTrechos, limparSaida, __test } from "../src/agents/runner.ts";

const docs = [{ nome: "TR", texto: "5.1. Local: Rua do Imperador, s/n, Santo Antônio, Recife PE.\nCNPJ 11.222.333/0001-81 e CEP 50.010-240.\nExperiência mínima em aquisições do Banco Interamericano de Desenvolvimento\n- BID" }];

// Guarda: dado escrito no documento passa (com ou sem máscara); inventado é recusado.
assert.equal(__test.guardaArgumento("validar_cnpj", { cnpj: "11222333000181" }, docs), null);
assert.equal(__test.guardaArgumento("validar_cep", { cep: "50010-240" }, docs), null);
assert.match(__test.guardaArgumento("validar_cep", { cep: "50010-000" }, docs), /não está escrito/);
assert.match(__test.guardaArgumento("validar_cnpj", { cnpj: "00000000000000" }, docs), /não está escrito/);

// Verificação de trechos: literal ok, quebra de linha ok, inventado falha.
const saida = `X\n1. [BAIXA] Item 5.1\n   Trecho: "Rua do Imperador, s/n, Santo Antônio"\n` +
  `2. [MÉDIA] Item 6\n   Trecho: "aquisições do Banco Interamericano de Desenvolvimento\n- BID"\n` +
  `3. [ALTA] Item 9\n   Trecho: "Rua Imperador Dom Pedro II"\n   Trecho: (ausente)\n`;
const v = verificarTrechos(saida, docs);
assert.equal(v.total, 3);
assert.deepEqual(v.naoEncontrados, ["Rua Imperador Dom Pedro II"]);

// Limpeza de formato: texto antes do cabeçalho é removido e registrado.
const l = limparSaida("Não há CNPJ, analiso agora.\n\nValidador de Dados — TR\n**Resumo**", "Validador de Dados");
assert.ok(l.texto.startsWith("Validador de Dados"));
assert.ok(!l.texto.includes("**"));
assert.equal(l.violacoes.length, 2);
console.log("runner-check OK");

// ── Controlador: regressão e extração da proposta ──────────────────────────────
const { avaliarRegressao, extrairProposta, mesmoTrecho } = await import("../src/agents/controlador.ts");
const V = (veredito, trecho, problema = "x") => ({ chave: "k", processId: "P1", agente: "a1-revisor", veredito, criticidade: "BAIXA", onde: "Item", problema, trecho, em: "" });
const vereditos = [
  V("falso_positivo", "Documento original ou cópia de Declaração, atestados, publicações"),
  V("procede", "submetendo à autoridade competente do Contratante, o que ultrapassar"),
  V("procede", "(ausente)", "falta a matriz de riscos"),
];
const nova = "Revisor — TR\n1 ponto.\n\n1. [BAIXA] Item 11.4\n   Problema: vírgula\n   Trecho: \"submetendo à autoridade competente do Contratante, o que ultrapassar a sua competência\"\n   Correção: remover\n";
const pl = avaliarRegressao({ P1: nova }, vereditos);
assert.equal(pl.falsosPositivos.eliminados, 1);                 // FP sumiu
assert.equal(pl.acertos.mantidos, 1);                           // acerto com trecho mantido
assert.equal(pl.acertos.perdidos.length, 1);                    // acerto de ausência perdido
assert.ok(mesmoTrecho("a Contratada deverá executar os serviços", "A CONTRATADA deverá executar os serviços conforme"));
assert.ok(!mesmoTrecho("prazo de vigência de 12 meses", "valor global estimado"));
const prop = extrairProposta("DIAGNÓSTICO:\n- padrão A\nMUDANÇAS:\n- regra B\nPROMPT REVISADO:\n<<<\nNome do agente: X\nnovo\n>>>");
assert.equal(prop.prompt, "Nome do agente: X\nnovo");
assert.equal(prop.diagnostico, "- padrão A");
console.log("controlador-check OK");

// Agente de 1 documento rodado por documento: blocos renumerados e "onde" com o nome do doc
{
  const { juntarResultados, AGENTES } = (await import("../src/agents/runner.ts")).__test;
  const { parseSaida } = await import("../src/agents/saida.ts");
  const r = (texto) => ({ status: "fulfilled", value: { texto, ms: 1, tokens: { entrada: 1, saida: 1 }, chamadasFerramenta: [], violacoes: [] } });
  const docs = [{ nome: "Termo de Referência", texto: "os impossibilite" }, { nome: "Minuta Contratual", texto: "fiscalisação" }];
  const j = juntarResultados(AGENTES[0], docs, [
    r('X — TR\n1 ponto.\n\n1. [MÉDIA] Item 9.2\nProblema: Concordância.\nTrecho: "os impossibilite"\nCorreção: o(a).\n\nConferido sem problema: grafia'),
    r('X — Minuta\n1 ponto.\n\n1. [BAIXA] Minuta Contratual, Cláusula 7.1\nProblema: Grafia.\nTrecho: "fiscalisação"\nCorreção: fiscalização.\n\nConferido sem problema: pontuação'),
  ]);
  const s = parseSaida(j.texto);
  const ok = s.problemas.length === 2 && s.problemas[1].n === 2 && s.problemas[0].onde === "Termo de Referência — Item 9.2"
    && s.problemas[1].onde === "Minuta Contratual, Cláusula 7.1" && j.verificacao.naoEncontrados.length === 0 && !j.erro;
  console.log(ok ? "juntar-check OK" : "juntar-check FALHOU\n" + j.texto);
  if (!ok) process.exitCode = 1;
}
