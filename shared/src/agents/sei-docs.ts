/**
 * Lista os documentos de um processo a partir do HTML da árvore do SEI (iframe
 * #ifrArvore). Validado no SEI 5.0.5 do TJPE: cada documento é um nó
 *   Nos[i] = new infraArvoreNo("DOCUMENTO","<idInterno>","<pasta>","<link>","<alvo>","<título>","<título>","svg/<ícone>.svg?25",...,"<nºSEI>")
 *   Nos[i].src = '<link direto>'   ← documento_visualizar (HTML) ou documento_download_anexo (PDF)
 * O link já vem com infra_hash gerado pelo servidor (reutilizável). NUNCA montar URL.
 */

export type TipoDoc = "pdf" | "interno" | "formulario" | "outro";
export interface DocArvore { idInterno: string; numero: string; titulo: string; tipo: TipoDoc; src: string }

// Só ações de LEITURA. O HTML do SEI tem links que excluem/enviam/concluem processo.
const ACOES_LEITURA = /^controlador\.php\?acao=(documento_visualizar|documento_download_anexo)&/;
export const ehLinkDeLeitura = (src: string) => ACOES_LEITURA.test(src);

const desfazEntidades = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function parseArvore(html: string): DocArvore[] {
  const nos = new Map<string, Omit<DocArvore, "src"> & { src?: string }>();
  for (const m of html.matchAll(/Nos\[(\d+)\] = new infraArvoreNo\("DOCUMENTO",[^\n]*/g)) {
    const args = [...m[0].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    const icone = args[7] ?? "";
    const tipo: TipoDoc = /documento_pdf/.test(icone) ? "pdf"
      : /documento_interno/.test(icone) ? "interno"
      : /formulario/.test(icone) ? "formulario" : "outro";
    const titulo = desfazEntidades(args[5] ?? "");
    // A posição do nº SEI varia entre nós ("noVisitado" às vezes ocupa o lugar): pega o último
    // argumento só com dígitos que não seja o id interno; se não houver, o número no título.
    const numero = [...args].reverse().find((a) => /^\d{6,9}$/.test(a) && a !== args[1])
      ?? titulo.match(/\b(\d{6,9})\b/)?.[1] ?? "";
    nos.set(m[1], { idInterno: args[1], titulo, numero, tipo });
  }
  for (const m of html.matchAll(/Nos\[(\d+)\]\.src = '([^']*)'/g)) {
    const n = nos.get(m[1]);
    if (n) n.src = desfazEntidades(m[2]);
  }
  return [...nos.values()].filter((n): n is DocArvore => !!n.src && ehLinkDeLeitura(n.src));
}

/** HTML de documento interno do SEI → texto com uma linha por bloco (as ferramentas
 *  dependem de "início de linha" para numeração e seções). Só no navegador (DOMParser). */
export function htmlParaTexto(html: string): string {
  const d = new DOMParser().parseFromString(html, "text/html");
  d.querySelectorAll("script,style,noscript").forEach((e) => e.remove());
  d.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
  d.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,table,section,article").forEach((e) => e.append("\n"));
  d.querySelectorAll("td,th").forEach((e) => e.append(" "));
  return (d.body?.textContent ?? "").split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}

/** Documentos que normalmente merecem revisão — vêm pré-marcados na tela. */
export const ehDocumentoPrincipal = (titulo: string) =>
  /termo de refer|estudo t[ée]cnico|\bETP\b|\bTR\b|projeto b[áa]sico|\bDFD\b|formaliza[çc][ãa]o d[ae] demanda|edital|minuta/i.test(titulo);
