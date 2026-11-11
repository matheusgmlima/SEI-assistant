/**
 * Extrai o texto de um PDF preservando quebras de linha — as ferramentas
 * (numeração, seções, referências) dependem de "início de linha".
 * Roda no navegador (extensão) e no Node (scripts). PDF escaneado (imagem)
 * devolve texto vazio: nesse caso o modelo lê o PDF nativamente.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function pdfToText(data: Uint8Array): Promise<{ texto: string; paginas: number }> {
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const partes: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    let linha = "";
    let ultimoY: number | null = null;
    const linhas: string[] = [];
    for (const it of items as { str: string; hasEOL?: boolean; transform: number[] }[]) {
      const y = it.transform[5];
      // Mudança de altura sem hasEOL também é nova linha (tabelas, colunas)
      if (ultimoY !== null && Math.abs(y - ultimoY) > 2 && linha.trim()) { linhas.push(linha); linha = ""; }
      linha += it.str;
      ultimoY = y;
      if (it.hasEOL) { linhas.push(linha); linha = ""; }
    }
    if (linha.trim()) linhas.push(linha);
    partes.push(linhas.map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).filter((l) => l.trim()).join("\n"));
  }
  // Hifenização de fim de linha ("articu-\nlação") não é erro de grafia do documento.
  const texto = partes.join("\n\n").replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2");
  return { texto, paginas: doc.numPages };
}
