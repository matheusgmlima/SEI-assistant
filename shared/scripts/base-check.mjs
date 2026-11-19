// Checagens da base de modelos (sem banco e sem modelo). Uso: node shared/scripts/base-check.mjs
import assert from "node:assert/strict";
import { secionar, tipoPeloTitulo, categoriaDoTexto, novoModelo, escolherModelos, grupoDaUnidade } from "../src/base/modelos.ts";

// Seções: título numerado, cláusula por extenso e "DAS ..." viram seção; item longo e sumário não.
const tr = [
  "TERMO DE REFERÊNCIA", "SUMÁRIO", "1 OBJETO ........ 2", "2 PRAZO ........ 3",
  "1. DO OBJETO", "1.1. Aquisição de mobiliário para o Fórum do Recife, conforme especificações.",
  "2. PRAZO DE ENTREGA", "2.1. O fornecedor deverá entregar em até 30 dias.",
  "CLÁUSULA TERCEIRA – DAS SANÇÕES", "Multa de 10% sobre o valor.",
].join("\n");
const s = secionar(tr);
assert.deepEqual(s.map((x) => x.numero), [null, "1", "2", "CLÁUSULA TERCEIRA"]);
assert.equal(s[1].titulo, "DO OBJETO");
assert.equal(s[3].titulo, "DAS SANÇÕES");
assert.match(s[2].texto, /30 dias/);
assert.equal(secionar("texto corrido sem títulos.\noutra linha.").length, 1);

assert.equal(tipoPeloTitulo("Termo de Referência 123"), "tr");
assert.equal(tipoPeloTitulo("Estudo Técnico Preliminar - ETP"), "etp");
assert.equal(tipoPeloTitulo("Minuta de Contrato"), "minuta");
assert.equal(categoriaDoTexto("aquisição de mobiliário"), "bens");
assert.equal(categoriaDoTexto("reforma do edifício sede"), "obras");

// Escolha: só a caixinha e o tipo certos; o mais parecido primeiro; oficial vence empate.
const m = (titulo, texto, natureza = "modelo_oficial", grupo = "BID") => novoModelo({ titulo, texto, grupo, natureza });
const base = [
  m("TR mobiliário", "1. DO OBJETO\nAquisição de mobiliário escritório cadeiras mesas armários", "exemplo"),
  m("TR mobiliário oficial", "1. DO OBJETO\nAquisição de mobiliário escritório cadeiras mesas armários"),
  m("TR notebooks", "1. DO OBJETO\nAquisição de notebooks computadores licenças software"),
  m("TR mobiliário outra unidade", "1. DO OBJETO\nAquisição de mobiliário escritório cadeiras mesas", "modelo_oficial", "OUTRA"),
  m("ETP mobiliário", "1. DO OBJETO\nAquisição de mobiliário escritório cadeiras mesas armários"),
];
base[4].tipo = "etp";
const e = escolherModelos(base, { grupo: "BID", tipo: "tr", texto: "Objeto: aquisição de cadeiras e mesas de escritório (mobiliário)" });
assert.deepEqual(e.map((x) => x.modelo.titulo), ["TR mobiliário oficial", "TR mobiliário", "TR notebooks"]);
assert.ok(e[0].pontos > e[2].pontos);

// Caixinhas: unidades do mesmo grupo compartilham; sem grupo, a unidade é a própria caixinha.
const grupos = [{ nome: "BID", unidades: ["UGP - BID", "COORD. AQUISIÇÕES - BID"] }];
assert.equal(grupoDaUnidade(grupos, "ugp  - bid"), "BID");
assert.equal(grupoDaUnidade(grupos, "SEAD"), "SEAD");
console.log("base-check OK");
