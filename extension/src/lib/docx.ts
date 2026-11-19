/**
 * Word (.docx) mínimo, sem dependência nova (JSZip já está no projeto): título, quadro
 * "Pontos a conferir" e as seções, com os trechos a conferir em amarelo + número [n].
 */
import JSZip from "jszip";
import type { Rascunho } from "@shared/base/gerar";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (t: string, o: { b?: boolean; amarelo?: boolean; sup?: boolean; cor?: string; tam?: number } = {}) =>
  `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}${o.amarelo ? '<w:highlight w:val="yellow"/>' : ""}${o.cor ? `<w:color w:val="${o.cor}"/>` : ""}` +
  `${o.tam ? `<w:sz w:val="${o.tam}"/>` : ""}${o.sup ? '<w:vertAlign w:val="superscript"/>' : ""}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const par = (runs: string, o: { estilo?: string; antes?: number; just?: boolean } = {}) =>
  `<w:p><w:pPr>${o.estilo ? `<w:pStyle w:val="${o.estilo}"/>` : ""}<w:spacing w:before="${o.antes ?? 0}" w:after="120"/>${o.just ? '<w:jc w:val="both"/>' : ""}</w:pPr>${runs}</w:p>`;

export async function rascunhoParaDocx(r: Rascunho, cab: { titulo: string; processo: string; modelo: string }): Promise<Blob> {
  const corpo: string[] = [];
  corpo.push(par(run(cab.titulo, { b: true, tam: 32 })));
  corpo.push(par(run(`Rascunho gerado pelo SEI Assistant para o processo ${cab.processo}, a partir de: ${cab.modelo}. ` +
    "Os trechos em amarelo precisam ser conferidos ou completados antes de usar o documento.", { cor: "555555", tam: 18 })));

  if (r.pontos.length || r.pendencias.length) {
    corpo.push(par(run("PONTOS A CONFERIR", { b: true }), { antes: 200 }));
    for (const p of r.pontos) corpo.push(par(run(`[${p.n}] `, { b: true }) + run(`${p.secao ? `${p.secao}: ` : ""}`, { cor: "555555" }) +
      run(p.trecho, { amarelo: true }) + run(` — ${p.motivo}`)));
    if (r.pendencias.length) {
      corpo.push(par(run("Pendências", { b: true }), { antes: 120 }));
      for (const x of r.pendencias) corpo.push(par(run(`• ${x}`)));
    }
    corpo.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  for (const s of r.secoes) {
    if (s.titulo) corpo.push(par(run(s.titulo, { b: true }), { antes: 240 }));
    for (const p of s.paragrafos) corpo.push(par(p.map((x) => x.conferir
      ? run(x.texto, { amarelo: true }) + run(`[${x.conferir.n}]`, { sup: true, b: true, cor: "B45309" })
      : run(x.texto)).join(""), { just: true }));
  }

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = new JSZip();
  const f = (nome: string, xml: string) => zip.file(nome, xml, { createFolders: false }); // sem entradas de pasta: o Word às vezes reclama
  f("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  f("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  f("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  f("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`);
  f("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${corpo.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
