/**
 * extension/src/background/index.ts
 *
 * Service worker — gerencia sessão, side panel e chamadas de IA.
 */

import type { ExtMessage, SessionInfo, ProcessDetails } from "@shared/index";
import {
  upsertProcesso,
  upsertDespacho,
  mergeAndamentos,
  getAndamentosByProcesso,
  needsSync,
} from "../db/index";

// ─── Tipos de IA ────────────────────────────────────────────────────────────────

export interface AiConfig {
  provider: "groq" | "openai" | "custom";
  apiKey: string;
  model: string;
  baseUrl: string;
}

export const AI_PRESETS: Record<string, Omit<AiConfig, "apiKey" | "provider">> = {
  groq:   { baseUrl: "https://api.groq.com/openai/v1",  model: "llama-3.3-70b-versatile" },
  openai: { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini" },
  custom: { baseUrl: "",                                 model: "" },
};

// ─── Sessão ────────────────────────────────────────────────────────────────────

const DEFAULT_SESSION: SessionInfo = {
  status: "idle", username: null, unit: null, detectedAt: null,
};

async function clearSession() {
  await chrome.storage.local.set({ session: DEFAULT_SESSION });
}

// ─── IA ────────────────────────────────────────────────────────────────────────

function buildPrompt(details: ProcessDetails): string {
  // Andamento completo — ordenado do mais recente ao mais antigo
  const andamentoSorted = [...details.andamento].sort((a, b) => {
    const da = a.date?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const db = b.date?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const ta = da ? new Date(`${da[3]}-${da[2]}-${da[1]}`).getTime() : 0;
    const tb = db ? new Date(`${db[3]}-${db[2]}-${db[1]}`).getTime() : 0;
    return tb - ta;
  });

  // Status atual derivado do andamento mais recente
  const ultimoAndamento = andamentoSorted[0];
  const isConcluido = /conclus/i.test(ultimoAndamento?.description ?? "");
  const isArquivado = /arquiv/i.test(ultimoAndamento?.description ?? "");
  const statusAndamento = ultimoAndamento
    ? `ÚLTIMA MOVIMENTAÇÃO (ESTADO ATUAL): ${ultimoAndamento.date} — "${ultimoAndamento.description}" — Unidade: ${ultimoAndamento.unit ?? "?"}`
    : "Sem andamentos registrados";
  const conclusaoAlert = isConcluido
    ? `\n⚠️ ATENÇÃO: O processo foi CONCLUÍDO em ${ultimoAndamento?.date} na unidade ${ultimoAndamento?.unit ?? "?"}. Reflita isso no Status atual.`
    : isArquivado
    ? `\n⚠️ ATENÇÃO: O processo foi ARQUIVADO em ${ultimoAndamento?.date}. Reflita isso no Status atual.`
    : "";

  const andamentoText = andamentoSorted.length > 0
    ? andamentoSorted
        .slice(0, 40)
        .map((a) => `• ${a.date} [${a.unit ?? "?"}] — ${a.description}`)
        .join("\n")
    : "Não disponível";

  const despachos = details.documents.filter((d) => /^despacho\s+\d+/i.test(d));
  const outrosDocs = details.documents.filter((d) => !/^despacho\s+\d+/i.test(d));

  // Agrupa despachos por unidade para o prompt
  const despachosPorUnidade: Record<string, string[]> = {};
  for (const d of despachos) {
    const m = d.match(/despacho\s+\d+\s+(.*)/i);
    const unit = m?.[1]?.trim() ?? "Sem unidade";
    if (!despachosPorUnidade[unit]) despachosPorUnidade[unit] = [];
    despachosPorUnidade[unit].push(d);
  }
  const despachosPorUnidadeText = Object.entries(despachosPorUnidade)
    .map(([unit, ds]) => `  ${unit} (${ds.length}): ${ds.map((d) => d.match(/\d{5,8}/)?.[0] ?? d).join(", ")}`)
    .join("\n");

  // Conteúdo real de despachos lidos (filtra mensagens de restrição)
  // Aumentado de 14k → 60k chars para acomodar processos com muitos despachos
  // (Groq llama-3.3-70b suporta 128k tokens de contexto).
  const hasRealContent = !!(details.despachosContent && details.despachosContent.length > 100);
  const despachosContentText = hasRealContent
    ? details.despachosContent!.slice(0, 60000)
    : "";
  const contentTruncated = hasRealContent && details.despachosContent!.length > 60000;

  // Outros documentos relevantes (exclui genéricos)
  const outrosRelevantes = outrosDocs
    .filter((d) => !/^(I|II|III|IV|V|Aguarde)/i.test(d))
    .slice(0, 30)
    .join("\n  ");

  // Extrai eventos-chave do andamento para destacar no prompt
  const eventosChave = andamentoSorted
    .filter((a) => /conclus|aprova|autoriza|negad|indeferid|arquiv|encerr|reaber|remetid|recebid/i.test(a.description))
    .slice(0, 20)
    .map((a) => `  • ${a.date} [${a.unit ?? "?"}] ${a.description}`)
    .join("\n");

  return `Você é um analista jurídico do TJPE. Analise este processo SEI e produza um resumo executivo preciso com foco na trajetória decisória.
${conclusaoAlert}

PROCESSO: ${details.id}
TIPO: ${details.type ?? "Não identificado"}
ESPECIFICAÇÃO: ${details.description ?? "Não disponível"}
UNIDADE ATUAL: ${details.currentUnit ?? "Não disponível"}
INTERESSADOS: ${details.parties.join(", ") || "Não identificado"}

━━━ ESTADO ATUAL DO PROCESSO ━━━
${statusAndamento}

━━━ DESPACHOS (${despachos.length} total — agrupados por unidade criadora) ━━━
${despachosPorUnidadeText || "Nenhum"}

━━━ OUTROS DOCUMENTOS (${outrosDocs.length}) ━━━
${outrosRelevantes || "Nenhum"}

━━━ EVENTOS-CHAVE (aprovações, conclusões, negações, remessas) ━━━
${eventosChave || "Nenhum evento-chave identificado"}

━━━ HISTÓRICO COMPLETO (${details.andamento.length} registros — mais recentes primeiro) ━━━
${andamentoText}
${andamentoSorted.length > 40 ? `... e mais ${andamentoSorted.length - 40} registros anteriores` : ""}

${hasRealContent ? `━━━ CONTEÚDO DOS DOCUMENTOS LIDOS ━━━\nEXTRAIA DAQUI o objeto, valores, partes envolvidas, CNPJ, datas e decisões específicas. LEIA TUDO antes de responder.${contentTruncated ? "\n(Conteúdo truncado em 60KB — use os primeiros + últimos despachos como referência principal)" : ""}\n${despachosContentText}` : "NOTA: Conteúdo textual não disponível (acesso restrito). INFIRA o objeto e decisões a partir dos TÍTULOS dos despachos (que indicam unidade e ação) e do nome dos documentos (Termo de Referência, Contrato, Empenho, etc.)."}

━━━ INSTRUÇÕES DE RESPOSTA ━━━

Responda EXATAMENTE no formato abaixo, em português, sem preâmbulo. Cada seção tem regras próprias — siga-as à risca.

REGRAS DE INFERÊNCIA (LEIA COM ATENÇÃO):
• EXTRAIA AGRESSIVAMENTE do conteúdo dos documentos: nomes de empresas, CNPJs, valores em R$, datas (dd/mm/aaaa), números de contrato, modalidade de licitação, objeto contratual.
• INFIRA quando estiver evidente pelo contexto: ex: presença de "Termo de Referência" + "Minuta Contratual" + "Empenho" → é uma CONTRATAÇÃO; presença de "Pregão Eletrônico" → modalidade Pregão; documento "Cronograma de desembolso" → contrato com pagamento parcelado.
• Use TÍTULOS de despachos e documentos como pistas: "Despacho 1234 ASSESSORIA JURIDIC" + texto sobre análise jurídica → "Emitiu parecer técnico"; documento "Publicação EXTRATO" → "Publicou extrato no DOE".
• Só escreva "não informado" se realmente não conseguir inferir do título OU conteúdo. Prefira uma descrição cautelosa ("contratação de serviços técnicos — detalhes nos documentos") a "não informado".
• Para DATAS: extraia as datas dd/mm/aaaa que aparecem no conteúdo dos despachos. Se o andamento estiver vazio mas o despacho menciona "Em 15/03/2025, ...", use essa data.
• O Status atual deve refletir o ESTADO ATUAL — derive do andamento se houver; se vazio, use a data do despacho/empenho mais recente.

────────────────────────────────────────
**Assunto**
Liste em formato chave: valor, uma por linha, prefixada por "• ". OMITA campos que realmente não conseguir preencher (não escreva "Não informado" — simplesmente pule a linha):
• Objeto: [1 frase clara — ex: "Contratação de empresa de consultoria para gerência de projetos do BID", "Aquisição de mobiliário", "Apuração disciplinar"]
• Modalidade/Categoria: [Pregão Eletrônico nº NN/AAAA, Adesão a ARP, Dispensa, Inexigibilidade, Contratação direta — INFIRA pelo tipo do processo e documentos]
• Valor estimado: [R$ X.XXX,XX]
• Fornecedor/Contratado: [nome da empresa + CNPJ se disponível]
• Interessados: [partes do processo se diferentes do fornecedor — pule se redundante]
• Vigência/Prazo: [datas ou duração — ex: "12 meses a partir de dd/mm/aaaa"]
• Origem: [unidade demandante + data de abertura]
• Observações: [1 linha SE houver algo crítico não capturado acima — ex: aditivos, glosa, recurso pendente]

────────────────────────────────────────
**Caminhada do processo**
Liste cronologicamente (mais antigo → mais recente) os PONTOS DE DECISÃO. Use EXATAMENTE este formato:
→ dd/mm/aaaa [UNIDADE]: ação concreta (cite nº do despacho/doc quando aplicável)

REGRAS PARA DATAS:
• Use datas do andamento histórico se disponível.
• Se o andamento estiver vazio, EXTRAIA datas do conteúdo dos despachos (procure padrões dd/mm/aaaa no texto).
• Se realmente não tiver data, use "[s/d]" em vez de "não informado". Ex: → [s/d] [UGP - BID]: Emitiu DFD 3347371.

INCLUA APENAS eventos com substância (máximo 8 linhas, condense repetições):
• Abertura, instauração, autuação
• Pareceres jurídicos / técnicos (favoráveis ou contrários)
• Autorizações, ratificações, homologações, adjudicações
• Publicações (DOE, DJE) — cite extrato/edital
• Empenhos, assinaturas de contrato, ordens de serviço
• Negações, indeferimentos, devoluções
• Conclusões, arquivamentos

────────────────────────────────────────
**Status atual**
1 linha: "[Estado] em dd/mm/aaaa na [UNIDADE] — [última ação relevante]". Estados: Em análise / Aguardando parecer / Aguardando assinatura / Em execução / Concluído / Arquivado / Sobrestado / Devolvido. Se a data não estiver disponível, omita "em dd/mm/aaaa".

────────────────────────────────────────
**Próxima ação sugerida**
1-2 frases com ação CONCRETA. Não sugira nada se o processo está concluído/arquivado (escreva "Nenhuma — processo concluído").`;
}

async function callAi(config: AiConfig, prompt: string): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "Você é um assistente jurídico especializado em processos administrativos do TJPE. Seja objetivo, claro e profissional. Responda sempre em português.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 2600,
      temperature: 0.15,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Erro na API (${res.status}): ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da IA.");
  return content;
}

// NOTA: o fetch direto via background (com cookies de sessão) foi removido —
// reusar `infra_hash` causa logout por invalidação CSRF do SEI. Toda extração
// de conteúdo de documento agora é feita pelo content script via clique no DOM,
// que reaproveita a sessão sem violar o token.

// ─── Sync para IndexedDB ───────────────────────────────────────────────────────

async function syncProcessoToDB(details: ProcessDetails): Promise<void> {
  try {
    // Determina título do último despacho para sync incremental
    const despachos = details.documents.filter((d) => /^despacho\s+\d+/i.test(d));
    const ultimoDocTitulo = despachos[despachos.length - 1] ?? null;

    // Upsert processo
    await upsertProcesso({
      id: details.id,
      tipo: details.type,
      descricao: details.description,
      unidade_atual: details.currentUnit,
      partes: details.parties,
      ultimo_doc_titulo: ultimoDocTitulo,
      atualizado_em: Date.now(),
    });

    // Upsert cada despacho com id_doc extraído do título
    for (const titulo of despachos) {
      const match = titulo.match(/\b(\d{5,8})\b/);
      if (!match) continue;
      const id_doc = match[1];

      // Tenta associar data do andamento ao despacho pelo id_doc
      const andEntry = details.andamento.find((a) => a.description?.includes(id_doc));

      await upsertDespacho({
        id_doc,
        processo_id: details.id,
        titulo,
        data: andEntry?.date ?? null,
        setor: andEntry?.unit ?? null,
        conteudo: null, // preenchido depois pelo fetchDespachosContent
      });
    }

    // Merge andamentos no banco (acumula, não substitui)
    if (details.andamento.length > 0) {
      const { added, total } = await mergeAndamentos(
        details.id,
        details.andamento.map((a) => ({
          data: a.date,
          unidade: a.unit ?? "",
          descricao: a.description,
        }))
      );
      console.log(`[SEI Assistant] DB andamentos: +${added} novos | total ${total}`);
    }

    console.log(`[SEI Assistant] DB: processo ${details.id} sincronizado (${despachos.length} despachos)`);
  } catch (e) {
    console.error("[SEI Assistant] DB sync error:", e);
  }
}

// NOTA: parser de andamento (parseAndamentoHtml) e extrator de próxima página
// (extractNextPageUrl) foram removidos — esses parsers só seriam usados se o
// background fizesse fetch HTTP direto, o que não fazemos (causa logout).
// A extração de andamento agora roda no content script (extractAndamento) e
// a paginação automática também (findNextPageLink).

// ─── Listener de mensagens ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "SESSION_ENDED": {
      clearSession();
      sendResponse({ ok: true });
      break;
    }

    case "OPEN_DASHBOARD": {
      chrome.tabs.create({ url: "http://localhost:5173" });
      sendResponse({ ok: true });
      break;
    }

    case "SUMMARIZE_PROCESS": {
      const { processId } = message.payload as { processId: string };
      const storageKey = `proc_${processId}`;

      chrome.storage.local.get(["aiConfig", storageKey], async (result) => {
        const config = result.aiConfig as AiConfig | undefined;
        let details = result[storageKey] as ProcessDetails | undefined;

        if (!config?.apiKey) {
          sendResponse({ ok: false, error: "API key não configurada. Vá em Configurações." });
          return;
        }

        if (!details) {
          sendResponse({ ok: false, error: "Dados não disponíveis. Abra o processo no SEI primeiro." });
          return;
        }

        // NOTA: fetch automático de despachos foi removido — causava logout por CSRF.
        // O conteúdo dos despachos é extraído pelo content script quando o usuário abre o doc.

        try {
          const summary = await callAi(config, buildPrompt(details));
          const updated: ProcessDetails = { ...details, summary };
          await chrome.storage.local.set({ [storageKey]: updated });

          // Atualiza DB com conteúdo dos despachos (se disponível)
          await syncProcessoToDB(updated);

          sendResponse({ ok: true, summary });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      });

      return true; // async
    }

    case "GET_ANDAMENTO": {
      // IMPORTANTE: NÃO fazemos fetch HTTP ao SEI — causa logout por invalidação de sessão.
      // O content script extrai o andamento do DOM quando o usuário abre "Consultar Andamento".
      // Este handler apenas lê o que já foi salvo no storage pelo content script.
      const { processId } = message.payload as { processId: string };
      const storageKey = `proc_${processId}`;

      chrome.storage.local.get(storageKey, async (result) => {
        const details = result[storageKey] as ProcessDetails | undefined;

        if (!details) {
          sendResponse({ ok: false, error: "Abra o processo no SEI primeiro." });
          return;
        }

        if (!details.andamento || details.andamento.length === 0) {
          sendResponse({
            ok: false,
            error: "Abra 'Consultar Andamento' no SEI. O assistente extrai automaticamente ao carregar a página.",
          });
          return;
        }

        // Sincroniza com IndexedDB e retorna
        await syncProcessoToDB(details);
        sendResponse({ ok: true, count: details.andamento.length });
      });

      return true; // async
    }

    // Verifica se o processo precisa re-sincronizar (último despacho mudou)
    case "CHECK_SYNC": {
      const { processId, ultimoDocTitulo } = message.payload as {
        processId: string;
        ultimoDocTitulo: string | null;
      };
      needsSync(processId, ultimoDocTitulo)
        .then((needs) => sendResponse({ ok: true, needsSync: needs }))
        .catch(() => sendResponse({ ok: true, needsSync: true }));
      return true;
    }

    // Coleta completa finalizada pelo content script → dispara IA automaticamente
    case "COLLECTION_DONE": {
      const { processId } = message.payload as { processId: string };
      const storageKey = `proc_${processId}`;

      chrome.storage.local.get(["aiConfig", storageKey], async (result) => {
        const config = result.aiConfig as AiConfig | undefined;
        const details = result[storageKey] as ProcessDetails | undefined;

        if (!config?.apiKey || !details) {
          chrome.storage.local.set({
            [`collecting_${processId}`]: {
              processId, status: "done", phase: "Concluído (sem chave de IA configurada)",
              step: 4, totalSteps: 4, startedAt: Date.now(),
            },
          });
          sendResponse({ ok: true });
          return;
        }

        try {
          // Merge andamento do DB com storage — garante dados completos para a IA
          const dbRows = await getAndamentosByProcesso(processId);
          const dbAndamento = dbRows.map((r) => ({
            date: r.data, unit: r.unidade, description: r.descricao,
          }));

          // Dedup por data+unidade+descrição
          const seen = new Set(details.andamento.map((e) => `${e.date}|${e.unit}|${e.description}`));
          const extra = dbAndamento.filter((e) => !seen.has(`${e.date}|${e.unit}|${e.description}`));
          const fullAndamento = [...details.andamento, ...extra];

          const detailsWithFullAndamento: ProcessDetails = { ...details, andamento: fullAndamento };

          const summary = await callAi(config, buildPrompt(detailsWithFullAndamento));
          const updated: ProcessDetails = { ...detailsWithFullAndamento, summary };
          await chrome.storage.local.set({ [storageKey]: updated });
          await syncProcessoToDB(updated);

          chrome.storage.local.set({
            [`collecting_${processId}`]: {
              processId, status: "done", phase: "Concluído!", step: 4, totalSteps: 4, startedAt: Date.now(),
            },
          });
          sendResponse({ ok: true });
        } catch (e) {
          chrome.storage.local.set({
            [`collecting_${processId}`]: {
              processId, status: "error", phase: "Erro ao gerar resumo.",
              step: 4, totalSteps: 4, startedAt: Date.now(), error: String(e),
            },
          });
          sendResponse({ ok: false, error: String(e) });
        }
      });

      return true;
    }

    // Lê andamentos diretamente do IndexedDB (sem fetch)
    case "GET_DB_ANDAMENTO": {
      const { processId } = message.payload as { processId: string };
      getAndamentosByProcesso(processId)
        .then((rows) =>
          sendResponse({
            ok: true,
            andamento: rows.map((r) => ({
              date: r.data,
              unit: r.unidade,
              description: r.descricao,
            })),
          })
        )
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  }
});

// ─── Auto-sync para IndexedDB via storage.onChanged ───────────────────────────
// Sempre que o content script salvar novos andamentos no storage, sincroniza
// automaticamente para o IndexedDB sem precisar que a sidebar peça.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("proc_")) continue;
    const details = change.newValue as ProcessDetails | undefined;
    if (!details?.andamento?.length) continue;

    // Sync assíncrono — não bloqueia
    syncProcessoToDB(details).catch((e) =>
      console.error("[SEI Assistant] Auto-sync erro:", e)
    );
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await clearSession();
  console.log("[SEI Assistant] Extensão instalada e pronta.");
});
