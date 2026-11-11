/**
 * Ferramentas determinísticas dos agentes — porte 1:1 do Python validado no
 * Autonomia (fonte: ./fonte/ferramentas.py.txt). A paridade é conferida por
 * scripts/tools-parity.mjs (roda o Python original e este porte no mesmo texto).
 *
 * Diferenças de motor de regex Python × JS tratadas aqui:
 * - `\w` do Python é Unicode; no JS é ASCII → usamos [\p{L}\p{N}_] com flag u.
 * - `str.split()` do Python ↔ `split(/\s+/)` filtrando vazios.
 * Sem dependências: roda no service worker da extensão e no Node (scripts).
 */

const W = "[\\p{L}\\p{N}_]"; // equivalente ao \w Unicode do Python

const squash = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isAlpha = (c: string) => /\p{L}/u.test(c);

function normalizarBR(v: string): number {
  const limpo = (v ?? "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  return limpo ? Number(limpo) : 0;
}
const round2 = (x: number) => Math.round(x * 100) / 100;

// ── Agente 6 ────────────────────────────────────────────────────────────────────
export function extrair_mencoes_numericas_temporais(texto: string) {
  texto = texto || "";
  const trecho = (inicio: number, fim: number, janela = 70) =>
    squash(texto.slice(Math.max(0, inicio - janela), fim + janela)).slice(0, 160);
  const classificar = (cauda: string) => {
    const c = cauda.toLowerCase();
    if (/^\s*(dias?|meses|mes|m[eê]s|anos?)\b/u.test(c)) return "prazo";
    if (/^\s*%/.test(c) || c.slice(0, 12).trim().startsWith("por cento")) return "percentual";
    return "quantitativo";
  };
  const vistos = new Set<string>();
  const mencoes: { tipo: string; valor: string; trecho: string }[] = [];
  const add = (tipo: string, valor: string, chaveValor: string, start: number, end: number) => {
    const chave = `${tipo}|${chaveValor}|${start}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);
    mencoes.push({ tipo, valor, trecho: trecho(start, end) });
  };

  for (const m of texto.matchAll(/R\$\s*[\d.]+,\d{2}/g)) add("valor", m[0], m[0], m.index!, m.index! + m[0].length);
  for (const m of texto.matchAll(/\b\d{1,3}(?:,\d+)?\s*%/g)) add("percentual", m[0], m[0], m.index!, m.index! + m[0].length);
  for (const m of texto.matchAll(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}\b/giu))
    add("data", m[0], m[0].toLowerCase(), m.index!, m.index! + m[0].length);
  for (const m of texto.matchAll(/\b\d{2}\/\d{2}\/\d{4}\b/g)) add("data", m[0], m[0], m.index!, m.index! + m[0].length);

  // Número com extenso entre parênteses: "420 (quatrocentos e vinte)", "60 (sessenta) dias".
  for (const m of texto.matchAll(/(?<!,)(?<!-)(?<!\.)(?<!\d)(\d{1,3}(?:\.\d{3})*)\s*\(([^)]{2,60})\)/g)) {
    const numero = m[1];
    const extenso = m[2].trim();
    if (!/^[a-zà-ú]+(?:[\s,]+(?:e\s+)?[a-zà-ú]+)*$/.test(extenso)) continue;
    if ([...extenso].some((c) => isUpper(c) || /\d/.test(c))) continue;
    const end = m.index! + m[0].length;
    const tipo = classificar(texto.slice(end, end + 20));
    const valor = `${numero} (${extenso})`;
    add(tipo, valor, valor, m.index!, end);
  }
  return { mencoes };
}

// ── Agente 5 ────────────────────────────────────────────────────────────────────
function dvCnpjOk(valor: string): boolean {
  const n = valor.replace(/\D/g, "");
  if (n.length !== 14 || n === n[0].repeat(14)) return false;
  for (const tam of [12, 13]) {
    const pesos: number[] = [];
    for (let p = tam - 7; p > 1; p--) pesos.push(p);
    for (let p = 9; p > 1; p--) pesos.push(p);
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(n[i]) * pesos[i];
    const digito = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (Number(n[tam]) !== digito) return false;
  }
  return true;
}

export function extrair_dados_institucionais(texto: string) {
  texto = texto || "";
  const achar = (padrao: RegExp, filtro?: (v: string) => boolean) => {
    const vistos = new Set<string>();
    const saida: { valor: string; trecho: string }[] = [];
    for (const m of texto.matchAll(padrao)) {
      const valor = m[0].trim();
      if (filtro && !filtro(valor)) continue;
      if (vistos.has(valor)) continue;
      vistos.add(valor);
      const t = squash(texto.slice(Math.max(0, m.index! - 70), m.index! + m[0].length + 40));
      saida.push({ valor, trecho: t.slice(0, 120) });
    }
    return saida;
  };
  return {
    cnpj: achar(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, dvCnpjOk),
    cnpj_invalidos: achar(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, (v) => !dvCnpjOk(v)),
    cep: achar(/\b\d{5}-\d{3}\b/g),
    telefone: achar(/\(?\d{2}\)?\s?\d{4,5}-\d{4}/g),
    processo_sei: achar(/\b\d{8}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g),
    email: achar(new RegExp(`[${W.slice(1, -1)}.-]+@[${W.slice(1, -1)}.-]+\\.${W}{2,}`, "gu")),
  };
}

export function validar_cnpj(cnpj: string) {
  const digitos = (cnpj || "").replace(/\D/g, "");
  if (digitos.length !== 14) return { valido: false, motivo: "CNPJ deve ter 14 dígitos", cnpj_normalizado: digitos };
  if (digitos === digitos[0].repeat(14)) return { valido: false, motivo: "Todos os dígitos iguais", cnpj_normalizado: digitos };
  const calc = (parcial: string, pesos: number[]) => {
    const soma = [...parcial].reduce((a, d, i) => a + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = calc(digitos.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = calc(digitos.slice(0, 12) + dv1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const valido = digitos.slice(-2) === `${dv1}${dv2}`;
  const fmt = `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12, 14)}`;
  return { valido, motivo: valido ? "Dígitos verificadores corretos" : "Dígito verificador inválido", cnpj_normalizado: fmt };
}

export async function validar_cep(cep: string, endereco_esperado = "") {
  const digitos = (cep || "").replace(/\D/g, "");
  if (digitos.length !== 8) return { valido_formato: false, motivo: "CEP deve ter 8 dígitos", cep_normalizado: digitos };
  const resultado: Record<string, unknown> = { valido_formato: true, cep_normalizado: `${digitos.slice(0, 5)}-${digitos.slice(5)}` };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const data = await (await fetch(`https://viacep.com.br/ws/${digitos}/json/`, { signal: ctrl.signal })).json();
    clearTimeout(t);
    if (data.erro) resultado.existe = false;
    else {
      resultado.existe = true;
      const oficial = `${data.logradouro ?? ""}, ${data.bairro ?? ""}, ${data.localidade ?? ""}/${data.uf ?? ""}`;
      resultado.endereco_oficial = oficial;
      if (endereco_esperado) resultado.confere_com_esperado = oficial.toLowerCase().includes(endereco_esperado.toLowerCase());
    }
  } catch (e) {
    resultado.consulta_externa = `indisponível: ${e}`;
  }
  return resultado;
}

// ── Agente 4 ────────────────────────────────────────────────────────────────────
export function listar_secoes_do_documento(texto: string) {
  texto = texto || "";
  type Bruto = { numero: string; titulo: string; chave: string; posicao: number };
  const brutos: Bruto[] = [];
  for (const m of texto.matchAll(/^\s*(\d{1,2}(?:\.\d{1,2})?)\s*[.)]?\s*([A-ZÀ-Ú][^\n\d]{3,90})$/gm)) {
    const numero = m[1];
    const titulo = squash(m[2]).replace(/^[ .]+|[ .]+$/g, "");
    const letras = [...titulo].filter(isAlpha);
    if (titulo.length < 4 || letras.length === 0) continue;
    if (letras.filter(isUpper).length / letras.length < 0.7) continue;
    const chave = titulo.toUpperCase().replace(/[^A-ZÀ-Ú]/g, "");
    brutos.push({ numero, titulo, chave, posicao: m.index! });
  }
  const secoes: Bruto[] = [];
  const repetidos: string[] = [];
  for (const b of brutos) {
    const igual = secoes.find((s) => s.numero === b.numero && (s.chave.startsWith(b.chave) || b.chave.startsWith(s.chave)));
    if (igual) {
      if (b.chave.length > igual.chave.length) { igual.titulo = b.titulo; igual.chave = b.chave; }
      continue;
    }
    if (secoes.some((s) => s.numero === b.numero) && !repetidos.includes(b.numero)) repetidos.push(b.numero);
    secoes.push(b);
  }
  return {
    secoes: secoes.map((s) => ({ numero: s.numero, titulo: s.titulo, nivel: s.numero.includes(".") ? 2 : 1 })),
    numeros_repetidos: [...repetidos].sort(),
  };
}

// ── Agente 3 ────────────────────────────────────────────────────────────────────
export function verificar_detalhamento_sancoes(texto: string) {
  const t = (texto || "").toLowerCase();
  const tem_multa_percentual = /multa[^.]{0,200}?\d+\s*%|\d+\s*%[^.]{0,200}?multa/u.test(t);
  const tem_prazo_impedimento = new RegExp(
    `impedimento[^.]{0,150}?\\d+\\s*\\(?${W}*\\)?\\s*anos|inidone[oi]dade[^.]{0,150}?\\d+\\s*\\(?${W}*\\)?\\s*anos`, "u").test(t);
  const tem_dosimetria = /dosimetria|gradua[çc][ãa]o|natureza e a gravidade|circunst[âa]ncias agravantes|circunst[âa]ncias atenuantes/u.test(t);
  const tem_mencao_generica = /san[çc][ãa]o|penalidade|multa/u.test(t);
  const elementos = [tem_multa_percentual, tem_prazo_impedimento, tem_dosimetria].filter(Boolean).length;
  const sugestao = elementos >= 2 ? "atendido" : tem_mencao_generica ? "parcial" : "não atendido";
  return {
    multa_com_percentual: tem_multa_percentual,
    prazo_impedimento_ou_inidoneidade: tem_prazo_impedimento,
    criterios_dosimetria: tem_dosimetria,
    mencao_generica_a_sancoes: tem_mencao_generica,
    classificacao_sugerida: sugestao,
  };
}

// ── Agentes 2 e 3 ───────────────────────────────────────────────────────────────
export function verificar_clausulas_obrigatorias(texto: string) {
  texto = texto || "";
  const topicos: Record<string, string[]> = {
    subcontratacao: ["subcontrata"],
    matriz_de_riscos: ["matriz de risco"],
    garantias: ["garantia contratual", "garantia de execu[çc][ãa]o", "\\bgarantia\\b"],
    reajuste_repactuacao: ["reajuste", "repactua"],
    fiscalizacao: ["fiscaliza[çc][ãa]o", "fiscal do contrato"],
    recebimento_do_objeto: ["recebimento provis[óo]rio", "recebimento definitivo", "recebimento do objeto"],
    penalidades_sancoes: ["penalidade", "san[çc][ãa]o", "multa"],
  };
  const resultado: Record<string, { mencionado: boolean; trechos: string[] }> = {};
  for (const [topico, padroes] of Object.entries(topicos)) {
    let encontrado = false;
    const trechos: string[] = [];
    for (const p of padroes) {
      for (const m of texto.matchAll(new RegExp(p, "giu"))) {
        encontrado = true;
        trechos.push(texto.slice(Math.max(0, m.index! - 60), Math.min(texto.length, m.index! + m[0].length + 60)).trim());
      }
    }
    resultado[topico] = { mencionado: encontrado, trechos: trechos.slice(0, 3) };
  }
  return resultado;
}

// ── Agente 2 ────────────────────────────────────────────────────────────────────
export function extrair_prazos_do_texto(texto: string) {
  texto = texto || "";
  const out: { categoria: string; valor: number; unidade: string; trecho: string }[] = [];
  for (const m of texto.matchAll(/(\d+)\s*(?:\([^)]{0,30}\))?\s*dias\s*(corridos|úteis)/giu)) {
    const ini = Math.max(0, m.index! - 100);
    const fim = Math.min(texto.length, m.index! + m[0].length + 100);
    const ctx = texto.slice(ini, fim).toLowerCase();
    const categoria = ctx.includes("recebimento definitivo") ? "prazo_emissao_termo_recebimento_definitivo"
      : ctx.includes("recebimento provis") ? "prazo_recebimento_provisorio"
      : ctx.includes("garantia") ? "prazo_garantia"
      : ctx.includes("entrega") ? "prazo_entrega" : "outro";
    out.push({
      categoria,
      valor: Number(m[1]),
      unidade: m[2].toLowerCase(),
      trecho: texto.slice(Math.max(0, m.index! - 80), Math.min(texto.length, m.index! + m[0].length + 20)).trim(),
    });
  }
  return out;
}

export function comparar_valores_monetarios(valor1: string, valor2: string) {
  const n1 = normalizarBR(valor1), n2 = normalizarBR(valor2);
  return { valor1_normalizado: n1, valor2_normalizado: n2, iguais: n1 === n2, diferenca: round2(n1 - n2) };
}

// ── Agente 1 ────────────────────────────────────────────────────────────────────
export function verificar_total_calculado(valor_unitario: string, quantidade: string, valor_total_declarado: string) {
  const unit = normalizarBR(valor_unitario), qtd = normalizarBR(quantidade), total_declarado = normalizarBR(valor_total_declarado);
  const total_calculado = round2(unit * qtd);
  return {
    valor_unitario: unit, quantidade: qtd, total_calculado, total_declarado,
    confere: Math.abs(total_calculado - total_declarado) < 0.01,
    diferenca: round2(total_calculado - total_declarado),
  };
}

const MARCADOR = /^\s*(\d+(?:\.\d+)*)\.?\s/gm;

export function verificar_referencias_cruzadas(texto: string) {
  texto = texto || "";
  const existentes = new Set([...texto.matchAll(MARCADOR)].map((m) => m[1]));
  const citadas = [...texto.matchAll(/(?:item|subitem)\s+(?:n[ºo]\s*)?(\d+(?:\.\d+)*)/gi)].map((m) => m[1]);
  return {
    itens_existentes: [...existentes].sort(),
    referencias_citadas: citadas,
    referencias_quebradas: citadas.filter((r) => !existentes.has(r)),
  };
}

export function verificar_numeracao_sequencial(texto: string) {
  const problemas: { item: string; nivel: number; esperado: number; encontrado: number }[] = [];
  const anteriores = new Map<number, number>();
  for (const m of (texto || "").matchAll(MARCADOR)) {
    const item = m[1];
    const partes = item.split(".").map(Number);
    const nivel = partes.length;
    const atual = partes[nivel - 1];
    const anterior = anteriores.get(nivel);
    if (anterior !== undefined && atual !== anterior && atual !== anterior + 1)
      problemas.push({ item, nivel, esperado: anterior + 1, encontrado: atual });
    anteriores.set(nivel, atual);
    for (const n of [...anteriores.keys()]) if (n > nivel) anteriores.delete(n);
  }
  return problemas;
}

// ── Agente 6 (skill antiga "Inconsistências Sutis") ─────────────────────────────
export function checar_datas_conflitantes(datas: { label?: string; data?: string }[]) {
  const parse = (s?: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
  };
  const parsed = (datas || []).map((d) => ({ label: d.label ?? "?", data: parse(d.data) }));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const conflitos = [];
  for (let i = 0; i < parsed.length; i++)
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i], b = parsed[j];
      if (a.data && b.data && a.data > b.data)
        conflitos.push({
          anterior_esperado: a.label, data_anterior: iso(a.data),
          posterior_esperado: b.label, data_posterior: iso(b.data),
          observacao: `"${a.label}" está depois de "${b.label}" — checar se é intencional`,
        });
    }
  return conflitos;
}
