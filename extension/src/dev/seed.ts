/**
 * extension/src/dev/seed.ts
 *
 * Dados de TESTE: processos fictícios realistas para validar o fluxo completo
 * (Portfólio, Dashboard, Auditoria, Controle SAD) sem depender de coletar
 * processos reais do SEI. Marcados em `seedIds` para limpeza posterior.
 */

import type { ProcessDetails, AndamentoEntry } from "@shared/index";
import { buildChecklist, localFindings, computeScore, mergeFindings, detectCategory } from "@shared/index";

function a(date: string, unit: string, description: string): AndamentoEntry {
  return { date, unit, description };
}

function makeAudit(d: ProcessDetails): ProcessDetails["audit"] {
  const checklist = buildChecklist(d);
  const findings = mergeFindings(localFindings(d, checklist), []);
  const { score, riskLevel, breakdown } = computeScore(checklist, findings);
  return {
    processId: d.id, category: detectCategory(d), score, riskLevel,
    findings, checklist, aiSummary: null, breakdown, generatedAt: Date.now(),
  };
}

const BASE = {
  extractedAt: Date.now(),
  despachosContent: null as string | null,
  documentLinks: {} as Record<string, string>,
};

const SEED: ProcessDetails[] = [
  // 1) Contratação nova, em instrução interna (passa por GEPRO/GPP/Consult.Jur/NLCD)
  {
    ...BASE,
    id: "90000017-45.2026.8.17.8017",
    type: "Contratação de Serviços",
    description: "Contratação de empresa especializada em limpeza e conservação predial",
    currentUnit: "NLCD",
    parties: ["DG – Diretoria-Geral"],
    documents: [
      "Documento de Formalização da Demanda - DFD 100101 DG",
      "Termo de Referência 100205 GEPRO",
      "Pesquisa de Preços 100310 GPP",
      "Parecer Jurídico 100415 Consultoria Jurídica",
      "Despacho 100520 NLCD",
    ],
    andamento: [
      a("10/02/2026 09:14", "DG – Diretoria-Geral", "Processo autuado com Documento de Formalização da Demanda"),
      a("14/02/2026 11:30", "GEPRO", "Recebido para elaboração do Termo de Referência"),
      a("06/03/2026 16:02", "GPP", "Recebido para pesquisa de preços e estimativa de valor"),
      a("28/03/2026 10:45", "Consultoria Jurídica", "Recebido para análise jurídica da minuta"),
      a("20/05/2026 14:20", "NLCD", "Recebido para instrução da licitação"),
    ],
    summary: [
      "**Assunto**",
      "• Objeto: Contratação de empresa especializada em limpeza e conservação predial das unidades do TJPE",
      "• Modalidade: Pregão Eletrônico",
      "• Valor estimado: R$ 480.000,00",
      "• Vigência: 12 meses, prorrogável",
      "• Origem: DG – Diretoria-Geral",
      "",
      "**Caminhada do processo**",
      "→ 10/02/2026 [DG]: Abriu o processo com o DFD",
      "→ 06/03/2026 [GPP]: Realizou pesquisa de preços",
      "→ 28/03/2026 [Consultoria Jurídica]: Emitiu parecer favorável",
      "→ 20/05/2026 [NLCD]: Recebeu para instruir a licitação",
      "",
      "**Status atual**",
      "Em análise na NLCD desde 20/05/2026 — instrução da licitação.",
      "",
      "**Próxima ação sugerida**",
      "Concluir a instrução e publicar o edital de pregão.",
    ].join("\n"),
  },

  // 2) Prorrogação contratual já formalizada (contrato assinado)
  {
    ...BASE,
    id: "90000022-08.2025.8.17.8017",
    type: "Prorrogação Contratual",
    description: "Prorrogação do contrato de vigilância armada",
    currentUnit: "Consolidação",
    parties: ["SAD – Secretaria de Administração"],
    documents: [
      "Termo de Referência 200110 GEPRO",
      "Pesquisa de Preços 200215 GPP",
      "Parecer Jurídico 200320 Consultoria Jurídica",
      "Contrato 045/2025 200410 NLCD",
      "Nota de Empenho 200512 Consolidação",
      "Publicação EXTRATO 200615 Consolidação",
    ],
    andamento: [
      a("05/09/2025 08:50", "SAD – Secretaria de Administração", "Solicitação de prorrogação autuada"),
      a("12/09/2025 10:15", "GEPRO", "Atualização do Termo de Referência"),
      a("25/09/2025 09:40", "Consultoria Jurídica", "Parecer favorável à prorrogação"),
      a("10/11/2025 15:30", "NLCD", "Elaboração do termo aditivo"),
      a("15/12/2025 11:00", "Consolidação", "Contrato assinado e publicado"),
    ],
    summary: [
      "**Assunto**",
      "• Objeto: Prorrogação do contrato de prestação de serviços de vigilância armada",
      "• Modalidade: Pregão Eletrônico",
      "• Valor estimado: R$ 1.250.000,00",
      "• Fornecedor: Segurança Forte Ltda (CNPJ 12.345.678/0001-90)",
      "• Vigência: 12 meses a partir de 01/01/2026",
      "• Origem: SAD – Secretaria de Administração",
      "",
      "**Caminhada do processo**",
      "→ 05/09/2025 [SAD]: Autuou a solicitação de prorrogação",
      "→ 25/09/2025 [Consultoria Jurídica]: Parecer favorável",
      "→ 15/12/2025 [Consolidação]: Contrato assinado e extrato publicado",
      "",
      "**Status atual**",
      "Formalizado em 15/12/2025 — contrato 045/2025 vigente.",
      "",
      "**Próxima ação sugerida**",
      "Nenhuma — prorrogação concluída.",
    ].join("\n"),
  },

  // 3) Aquisição via ARP, PARADO há meses (gera alerta de prazo)
  {
    ...BASE,
    id: "90000031-77.2026.8.17.8017",
    type: "Aquisição de Material",
    description: "Aquisição de equipamentos de informática (notebooks)",
    currentUnit: "GPP",
    parties: ["SETIC – Secretaria de Tecnologia da Informação"],
    documents: [
      "Documento de Formalização da Demanda - DFD 300105 SETIC",
      "Termo de Referência 300210 GEPRO",
      "Despacho 300315 GPP",
    ],
    andamento: [
      a("08/12/2025 13:20", "SETIC – Secretaria de Tecnologia da Informação", "Processo autuado com DFD"),
      a("18/12/2025 09:05", "GEPRO", "Elaboração do Termo de Referência"),
      a("10/01/2026 16:40", "GPP", "Recebido para pesquisa de preços"),
    ],
    summary: [
      "**Assunto**",
      "• Objeto: Aquisição de 200 notebooks para modernização do parque tecnológico",
      "• Modalidade: Adesão a ARP",
      "• Valor estimado: R$ 1.800.000,00",
      "• Origem: SETIC – Secretaria de Tecnologia da Informação",
      "",
      "**Caminhada do processo**",
      "→ 08/12/2025 [SETIC]: Abriu o processo com o DFD",
      "→ 10/01/2026 [GPP]: Recebeu para pesquisa de preços",
      "",
      "**Status atual**",
      "Parado na GPP desde 10/01/2026 — aguardando pesquisa de preços.",
      "",
      "**Próxima ação sugerida**",
      "Cobrar a conclusão da pesquisa de preços na GPP.",
    ].join("\n"),
  },

  // 4) Processo concluído / arquivado
  {
    ...BASE,
    id: "90000044-12.2025.8.17.8017",
    type: "Contratação Direta",
    description: "Dispensa para manutenção de elevadores",
    currentUnit: "Consolidação",
    parties: ["SIOB – Diretoria de Manutenção"],
    documents: [
      "Documento de Formalização da Demanda - DFD 400105 SIOB",
      "Termo de Referência 400210 GEPRO",
      "Pesquisa de Preços 400315 GPP",
      "Parecer Jurídico 400420 Consultoria Jurídica",
      "Contrato 011/2025 400510 NLCD",
      "Ordem de Serviço 400612 Consolidação",
    ],
    andamento: [
      a("03/06/2025 10:00", "SIOB – Diretoria de Manutenção", "Processo autuado"),
      a("12/06/2025 14:25", "GEPRO", "Termo de Referência elaborado"),
      a("30/06/2025 09:10", "Consultoria Jurídica", "Parecer favorável à dispensa"),
      a("18/07/2025 11:35", "NLCD", "Contratação direta formalizada"),
      a("20/03/2026 16:00", "Consolidação", "Conclusão do processo na unidade"),
    ],
    summary: [
      "**Assunto**",
      "• Objeto: Contratação direta para manutenção preventiva e corretiva de elevadores",
      "• Modalidade: Dispensa",
      "• Valor estimado: R$ 95.000,00",
      "• Fornecedor: ElevaTech Manutenção ME (CNPJ 98.765.432/0001-10)",
      "• Vigência: 12 meses",
      "• Origem: SIOB – Diretoria de Manutenção",
      "",
      "**Caminhada do processo**",
      "→ 03/06/2025 [SIOB]: Abriu o processo",
      "→ 30/06/2025 [Consultoria Jurídica]: Parecer favorável",
      "→ 18/07/2025 [NLCD]: Formalizou a contratação direta",
      "→ 20/03/2026 [Consolidação]: Concluiu o processo",
      "",
      "**Status atual**",
      "Concluído em 20/03/2026 — contrato 011/2025.",
      "",
      "**Próxima ação sugerida**",
      "Nenhuma — processo concluído.",
    ].join("\n"),
  },
];

export async function seedTestData(): Promise<number> {
  const payload: Record<string, unknown> = {};
  const ids: string[] = [];
  for (const d of SEED) {
    payload[`proc_${d.id}`] = { ...d, audit: makeAudit(d) };
    ids.push(d.id);
  }
  payload["seedIds"] = ids;
  await chrome.storage.local.set(payload);
  return ids.length;
}

function getKey(key: string): Promise<Record<string, unknown>> {
  return new Promise((res) => chrome.storage.local.get(key as string, (r) => res(r as Record<string, unknown>)));
}

export async function clearTestData(): Promise<void> {
  const r = await getKey("seedIds");
  const ids = (r.seedIds as string[]) ?? [];
  const keys: string[] = ["seedIds"];
  for (const id of ids) keys.push(`proc_${id}`, `sadOverrides_${id}`, `qa_${id}`, `collecting_${id}`);
  await chrome.storage.local.remove(keys);
}

export async function hasSeed(): Promise<boolean> {
  const r = await getKey("seedIds");
  return ((r.seedIds as string[]) ?? []).length > 0;
}
