/**
 * shared/src/documents.ts
 *
 * Classificação de documentos importantes de um processo (Termo de Referência,
 * Contrato, Parecer, DFD, etc.). Usada para destacar documentos-chave na UI e
 * para priorizar a leitura do conteúdo durante a coleta.
 */

export interface ImportantDoc {
  title: string;
  docId: string | null;
  category: string;
  priority: number; // menor = mais importante
}

interface DocType {
  re: RegExp;
  category: string;
  priority: number;
}

// Ordem importa: o primeiro padrão que casar define a categoria.
const DOC_TYPES: DocType[] = [
  { re: /termo de refer[êe]ncia|\bTR\b/i,                  category: "Termo de Referência", priority: 1 },
  { re: /projeto b[áa]sico/i,                              category: "Projeto Básico",      priority: 1 },
  { re: /estudo t[ée]cnico preliminar|\bETP\b/i,           category: "ETP",                 priority: 2 },
  { re: /\bedital\b/i,                                     category: "Edital",              priority: 2 },
  { re: /minuta contratual|contrato|instrumento contratual/i, category: "Contrato",         priority: 2 },
  { re: /\bDFD\b|formaliza[çc][ãa]o d[ae] demanda/i,       category: "DFD",                 priority: 3 },
  { re: /parecer|assessoria jur[íi]dic|nota t[ée]cnica/i,  category: "Parecer/Nota Técnica", priority: 3 },
  { re: /pesquisa de pre[çc]o|estimativa|cota[çc][ãa]o|mapa de pre[çc]o|composi[çc][ãa]o de pre[çc]o/i, category: "Pesquisa de Preços", priority: 4 },
  { re: /homologa|adjudica|ratifica/i,                     category: "Homologação/Ratificação", priority: 4 },
  { re: /empenho/i,                                        category: "Empenho",             priority: 4 },
  { re: /ordem de servi[çc]o/i,                            category: "Ordem de Serviço",    priority: 5 },
  { re: /publica[çc][ãa]o|extrato/i,                       category: "Publicação/Extrato",  priority: 5 },
  { re: /\bata\b/i,                                        category: "Ata",                 priority: 5 },
  { re: /relat[óo]rio/i,                                   category: "Relatório",           priority: 6 },
];

function classify(title: string): DocType | null {
  for (const t of DOC_TYPES) {
    if (t.re.test(title)) return t;
  }
  return null;
}

/**
 * Extrai os documentos importantes da lista de títulos, ordenados por
 * importância (prioridade) e, dentro da mesma, do mais recente ao mais antigo
 * (docId maior = criado depois no SEI).
 */
export function extractImportantDocs(documents: string[]): ImportantDoc[] {
  const found: ImportantDoc[] = [];
  const seenDocId = new Set<string>();

  for (const title of documents) {
    const t = classify(title);
    if (!t) continue;
    const docId = title.match(/\b(\d{5,8})\b/)?.[1] ?? null;
    // dedup por docId
    if (docId) {
      if (seenDocId.has(docId)) continue;
      seenDocId.add(docId);
    }
    found.push({ title, docId, category: t.category, priority: t.priority });
  }

  return found.sort((a, b) =>
    a.priority - b.priority || (Number(b.docId) || 0) - (Number(a.docId) || 0)
  );
}

/** Versão curta do título, sem o número do documento (para exibição). */
export function cleanDocTitle(title: string): string {
  return title
    .replace(/\(?\b\d{5,8}\b\)?/g, "")     // remove o id numérico
    .replace(/\s{2,}/g, " ")
    .trim();
}
