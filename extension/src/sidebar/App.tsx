import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import type {
  SessionInfo, SeiProcess, ProcessDetails, AndamentoEntry,
  AuditResult, AuditFinding, AuditSeverity, ProcessStatusInfo, CollectionQueueState,
} from "@shared/index";
import { deriveStatus, extractImportantDocs, cleanDocTitle } from "@shared/index";
import { MODELOS, MODELO_PADRAO, LITELLM_URL, normalizarConfig, configLegada, type AiConfig } from "@shared/agents/llm";
import { RevisaoPanel, ControladorScreen } from "./Revisao";
import { Icon, ScreenHeader, type NomeIcone } from "./ui";

// ─── Tipos de view ──────────────────────────────────────────────────────────────
type View = "main" | "processes" | "processDetail" | "settings" | "controlador";
type DetailTab = "resumo" | "tramitacao" | "auditoria" | "perguntar" | "revisao";

// ─── Tramitação — tipos e lógica ────────────────────────────────────────────────

interface DespachoItem {
  title: string;
  date: string | null;   // data extraída do conteúdo ou andamento
  docId: string | null;
}

interface UnitPhase {
  unit: string;
  enteredAt: string | null;
  leftAt: string | null;
  durationDays: number | null;
  despachos: DespachoItem[];
  isCurrent: boolean;
  concluded: boolean;  // última entrada foi "Conclusão do processo na unidade"
}

function parseDate(s: string): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}`);
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  // "dd/mm/yyyy hh:mm" → "dd/mm/yy"
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[1]}/${m[2]}/${m[3].slice(2)}` : s;
}

/** Extrai data de um bloco de conteúdo de despacho (se disponível). */
function extractDateFromContent(title: string, despachosContent: string | null): string | null {
  if (!despachosContent) return null;
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionMatch = despachosContent.match(
    new RegExp(`===\\s*${escapedTitle}\\s*===([\\s\\S]{0,800})`, "i")
  );
  if (!sectionMatch) return null;
  const dateMatch = sectionMatch[1].match(/(\d{2}\/\d{2}\/\d{4})/);
  return dateMatch?.[1] ?? null;
}

/** Extrai unidade do título de despacho com badge: "Despacho 3341475 UGP - BID" → "UGP - BID" */
function unitFromDespacho(title: string): string {
  const m = title.match(/despacho\s+\d+\s+(.*)/i);
  return m?.[1]?.trim() ?? "";
}

/** Normaliza nome de unidade para matching fuzzy (remove códigos numéricos longos) */
function normalizeUnit(u: string): string {
  return u.toLowerCase()
    .replace(/[-\s]+\d{7,}/g, "")  // remove códigos "1200001000" etc.
    .replace(/\s+/g, " ").trim();
}

function unitsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizeUnit(a);
  const nb = normalizeUnit(b);
  if (na === nb) return true;
  // match parcial: um contém o outro (mínimo 5 chars para evitar falso positivo)
  if (na.length >= 5 && nb.length >= 5) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

function buildTramitacao(details: ProcessDetails): UnitPhase[] {
  const despachoTitles = details.documents.filter((d) => /^despacho\s+\d+/i.test(d));

  // Lista de despachos com sua unidade badge
  const allDespachos: DespachoItem[] = despachoTitles.map((title) => ({
    title,
    date: extractDateFromContent(title, details.despachosContent ?? null),
    docId: title.match(/\b(\d{5,8})\b/)?.[1] ?? null,
    unit: unitFromDespacho(title),
  } as DespachoItem & { unit: string }));

  // Mapa unidade normalizada → despachos
  const byUnit: Map<string, DespachoItem[]> = new Map();
  for (const d of allDespachos) {
    const unit = (d as DespachoItem & { unit: string }).unit || "—";
    if (!byUnit.has(unit)) byUnit.set(unit, []);
    byUnit.get(unit)!.push(d);
  }

  // ── Com andamento: fases com datas de entrada/saída por unidade ──────────────
  if (details.andamento.length > 0) {
    // Ordena andamento cronologicamente (mais antigo → mais recente)
    const sorted = [...details.andamento]
      .filter((e) => e.unit && e.date)
      .sort((a, b) => {
        const da = parseDate(a.date), db = parseDate(b.date);
        return (da?.getTime() ?? 0) - (db?.getTime() ?? 0);
      });

    // Reconstrói fases: cada vez que a unidade muda, abre nova fase
    const phases: UnitPhase[] = [];
    let current: UnitPhase | null = null;
    let lastDescription = "";

    for (const e of sorted) {
      const u = e.unit!.trim();
      lastDescription = e.description ?? "";

      if (!current || current.unit !== u) {
        if (current) current.leftAt = e.date;
        current = {
          unit: u,
          enteredAt: e.date,
          leftAt: null,
          durationDays: null,
          despachos: [],        // preenchido abaixo por docId proporcional
          isCurrent: false,
          concluded: false,
        };
        phases.push(current);
      }
    }

    // Detecta "Conclusão do processo na unidade" no último entry
    const isConcluded = /conclus/i.test(lastDescription);

    // Calcula durações e marca fase atual
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      p.isCurrent = i === phases.length - 1;
      p.concluded = p.isCurrent && isConcluded;

      if (p.isCurrent && isConcluded && sorted.length > 0) {
        const lastEntry = sorted[sorted.length - 1];
        if (lastEntry.unit?.trim() === p.unit) p.leftAt = lastEntry.date;
      }

      if (p.enteredAt && p.leftAt) {
        const a = parseDate(p.enteredAt), b = parseDate(p.leftAt);
        if (a && b) p.durationDays = Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
      } else if (p.isCurrent && !isConcluded && p.enteredAt) {
        const a = parseDate(p.enteredAt);
        if (a) p.durationDays = Math.round((Date.now() - a.getTime()) / 86400000);
      }
    }

    // ── Distribui despachos por fase via posição proporcional do docId ────────────
    // DocIds são sequenciais no SEI (maior = mais recente). Interpolamos cada
    // despacho para a fase cujo intervalo de tempo o cobre.
    const allDespachosWithId = allDespachos
      .filter((d) => d.docId !== null)
      .sort((a, b) => Number(a.docId) - Number(b.docId));

    const noIdDespachos = allDespachos.filter((d) => d.docId === null);

    if (phases.length > 0 && allDespachosWithId.length > 0) {
      const firstMs = parseDate(phases[0].enteredAt ?? "")?.getTime() ?? 0;
      const lastPhase = phases[phases.length - 1];
      const lastMs = lastPhase.leftAt
        ? (parseDate(lastPhase.leftAt)?.getTime() ?? Date.now())
        : Date.now();
      const totalMs = Math.max(lastMs - firstMs, 1);

      for (let di = 0; di < allDespachosWithId.length; di++) {
        // Posição proporcional na lista de docIds → tempo estimado de criação
        const ratio = allDespachosWithId.length > 1
          ? di / (allDespachosWithId.length - 1)
          : 0;
        const estimatedMs = firstMs + ratio * totalMs;

        // Encontra a fase cujo intervalo cobre esse tempo estimado
        let target = phases[phases.length - 1];
        for (const p of phases) {
          const pStart = parseDate(p.enteredAt ?? "")?.getTime() ?? 0;
          const pEnd = p.leftAt
            ? (parseDate(p.leftAt)?.getTime() ?? Date.now())
            : Date.now();
          if (estimatedMs >= pStart && estimatedMs <= pEnd) {
            target = p;
            break;
          }
        }
        target.despachos.push(allDespachosWithId[di]);
      }
    }

    // Despachos sem docId: atribui à fase por nome (fallback)
    for (const d of noIdDespachos) {
      const dUnit = (d as DespachoItem & { unit: string }).unit ?? "";
      const target = phases.find((p) => unitsMatch(p.unit, dUnit)) ?? phases[phases.length - 1];
      if (target) target.despachos.push(d);
    }

    return phases;
  }

  // ── Sem andamento: usa apenas títulos com badge ───────────────────────────────
  const result: UnitPhase[] = [];
  for (const [unit, despachos] of byUnit.entries()) {
    if (unit === "—") continue;
    result.push({ unit, enteredAt: null, leftAt: null, durationDays: null, despachos, isCurrent: false, concluded: false });
  }
  if (result.length > 0) result[result.length - 1].isCurrent = true;
  return result;
}

// ─── Hook: sessão ───────────────────────────────────────────────────────────────
const DEFAULT_SESSION: SessionInfo = { status: "idle", username: null, unit: null, detectedAt: null };

function useSession() {
  const [session, setSession] = useState<SessionInfo>(DEFAULT_SESSION);
  useEffect(() => {
    function read() {
      chrome.storage.local.get("session", (r) => { if (r.session) setSession(r.session); });
    }
    read();
    const iv = setInterval(read, 3000);
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.session?.newValue) setSession(c.session.newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => { clearInterval(iv); chrome.storage.onChanged.removeListener(fn); };
  }, []);
  return session;
}

// ─── Hook: progresso de coleta ─────────────────────────────────────────────────
interface CollectionProgress {
  processId: string;
  status: "running" | "done" | "error";
  phase: string;
  step: number;
  totalSteps: number;
  startedAt: number;
  error?: string;
}

function useCollectionProgress(processId: string | null) {
  const [progress, setProgress] = useState<CollectionProgress | null>(null);

  useEffect(() => {
    if (!processId) return;
    const key = `collecting_${processId}`;

    chrome.storage.local.get(key, (r) => { if (r[key]) setProgress(r[key]); });

    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c[key]?.newValue) setProgress(c[key].newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [processId]);

  function startCollection() {
    if (!processId) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, { type: "START_COLLECTION", payload: { processId } });
    });
  }

  function stopCollection() {
    if (!processId) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, { type: "STOP_COLLECTION", payload: { processId } }, () => {
        // Ignora erro se a aba mudou — a flag em storage também é checada
        if (chrome.runtime.lastError) { /* ok */ }
      });
    });
  }

  function reset() {
    if (!processId) return;
    chrome.storage.local.remove(`collecting_${processId}`);
    chrome.storage.local.remove(`cancelCollection_${processId}`);
    setProgress(null);
  }

  return { progress, startCollection, stopCollection, reset };
}

// ─── Hook: lista de processos ───────────────────────────────────────────────────
function useProcesses() {
  const [processes, setProcesses] = useState<SeiProcess[]>([]);
  const [collectedAt, setCollectedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [notOnPage, setNotOnPage] = useState(false);

  function readStorage() {
    chrome.storage.local.get(["processes", "processesCollectedAt"], (r) => {
      if (r.processes) setProcesses(r.processes);
      if (r.processesCollectedAt) setCollectedAt(r.processesCollectedAt);
    });
  }

  function collect() {
    setLoading(true); setNotOnPage(false);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { setLoading(false); setNotOnPage(true); return; }
      chrome.tabs.sendMessage(tabId, { type: "COLLECT_PROCESSES" }, (res) => {
        setLoading(false);
        if (chrome.runtime.lastError || !res?.ok || !res?.onPage) { setNotOnPage(true); return; }
        setTimeout(readStorage, 300);
      });
    });
  }

  useEffect(() => {
    readStorage();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.processes?.newValue) setProcesses(c.processes.newValue);
      if (c.processesCollectedAt?.newValue) setCollectedAt(c.processesCollectedAt.newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);

  return { processes, collectedAt, loading, notOnPage, collect };
}

// ─── Hook: portfólio (lista enriquecida com auditoria + status) ─────────────────
export interface PortfolioItem extends SeiProcess {
  audit: AuditResult | null;
  collected: boolean;
  statusInfo: ProcessStatusInfo | null;
}

function usePortfolio() {
  const { processes, collectedAt, loading, notOnPage, collect } = useProcesses();
  const [detailsMap, setDetailsMap] = useState<Record<string, ProcessDetails>>({});

  useEffect(() => {
    function readAll() {
      chrome.storage.local.get(null, (all) => {
        const map: Record<string, ProcessDetails> = {};
        for (const k of Object.keys(all)) {
          if (k.startsWith("proc_")) map[k.slice(5)] = all[k] as ProcessDetails;
        }
        setDetailsMap(map);
      });
    }
    readAll();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("proc_"))) readAll();
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);

  const items: PortfolioItem[] = useMemo(
    () =>
      processes.map((p) => {
        const d = detailsMap[p.id];
        return {
          ...p,
          audit: d?.audit ?? null,
          collected: !!d,
          statusInfo: d ? deriveStatus(d) : null,
        };
      }),
    [processes, detailsMap]
  );

  return { items, collectedAt, loading, notOnPage, collect };
}

// ─── Hook: fila de coleta em lote ────────────────────────────────────────────────
function useQueue() {
  const [queue, setQueue] = useState<CollectionQueueState | null>(null);

  useEffect(() => {
    chrome.storage.local.get("collectionQueue", (r) => setQueue((r.collectionQueue as CollectionQueueState) ?? null));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if ("collectionQueue" in c) setQueue((c.collectionQueue.newValue as CollectionQueueState) ?? null);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);

  function start(ids: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (!tabId) { resolve(false); return; }
        chrome.tabs.sendMessage(tabId, { type: "START_QUEUE", payload: { processIds: ids } }, (res) => {
          resolve(!chrome.runtime.lastError && !!res?.ok);
        });
      });
    });
  }

  function stop() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) chrome.tabs.sendMessage(tabId, { type: "STOP_QUEUE" }, () => { if (chrome.runtime.lastError) { /* ok */ } });
    });
    chrome.storage.local.remove("collectionQueue");
    setQueue(null);
  }

  function dismiss() {
    chrome.storage.local.remove("collectionQueue");
    setQueue(null);
  }

  return { queue, start, stop, dismiss };
}

// ─── Hook: detalhes de processo ─────────────────────────────────────────────────
function useProcessDetails(processId: string | null) {
  const [details, setDetails] = useState<ProcessDetails | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    if (!processId) return;
    const pid: string = processId; // narrow para closures
    const key = `proc_${pid}`;

    // Sempre busca do DB primeiro (fonte persistente) e merge com storage
    function loadFromBoth() {
      chrome.storage.local.get(key, (r) => {
        const stored: ProcessDetails | undefined = r[key];

        chrome.runtime.sendMessage(
          { type: "GET_DB_ANDAMENTO", payload: { processId: pid } },
          (res) => {
            const dbAndamento: AndamentoEntry[] = res?.ok ? (res.andamento ?? []) : [];
            const storageAndamento: AndamentoEntry[] = stored?.andamento ?? [];

            // Merge: DB + storage, dedup por data+unidade+descrição
            const seen = new Set<string>();
            const merged: AndamentoEntry[] = [];
            for (const e of [...dbAndamento, ...storageAndamento]) {
              const key2 = `${e.date}|${e.unit}|${e.description}`;
              if (!seen.has(key2)) { seen.add(key2); merged.push(e); }
            }

            if (stored) {
              setDetails({ ...stored, andamento: merged.length > 0 ? merged : storageAndamento });
            } else if (merged.length > 0) {
              setDetails({
                id: pid, type: null, description: null, currentUnit: null,
                parties: [], documents: [], andamento: merged,
                extractedAt: Date.now(), summary: null, despachosContent: null,
                documentLinks: {},
              });
            }
          }
        );
      });
    }

    loadFromBoth();

    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (!c[key]?.newValue) return;
      const stored: ProcessDetails = c[key].newValue;
      // Re-merge com DB ao receber atualização do storage
      chrome.runtime.sendMessage(
        { type: "GET_DB_ANDAMENTO", payload: { processId } },
        (res) => {
          const dbAndamento: AndamentoEntry[] = res?.ok ? (res.andamento ?? []) : [];
          const seen = new Set<string>();
          const merged: AndamentoEntry[] = [];
          for (const e of [...dbAndamento, ...(stored.andamento ?? [])]) {
            const k2 = `${e.date}|${e.unit}|${e.description}`;
            if (!seen.has(k2)) { seen.add(k2); merged.push(e); }
          }
          setDetails({ ...stored, andamento: merged.length > 0 ? merged : (stored.andamento ?? []) });
        }
      );
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [processId]);

  function generateSummary() {
    if (!processId) return;
    setSummarizing(true); setSummaryError(null);
    chrome.runtime.sendMessage(
      { type: "SUMMARIZE_PROCESS", payload: { processId } },
      (res) => {
        setSummarizing(false);
        if (!res?.ok) setSummaryError(res?.error ?? "Erro desconhecido.");
      }
    );
  }

  return { details, summarizing, summaryError, generateSummary };
}

// ─── Hook: auditoria ─────────────────────────────────────────────────────────────
function useAudit(processId: string | null, details: ProcessDetails | null) {
  const [auditing, setAuditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audit = details?.audit ?? null;

  function runAudit() {
    if (!processId) return;
    setAuditing(true); setError(null);
    chrome.runtime.sendMessage(
      { type: "AUDIT_PROCESS", payload: { processId } },
      (res) => {
        setAuditing(false);
        if (!res?.ok) setError(res?.error ?? "Erro ao gerar auditoria.");
        // O resultado chega via storage.onChanged → useProcessDetails atualiza `details.audit`
      }
    );
  }

  return { audit, auditing, error, runAudit };
}

// ─── Hook: Q&A (pergunte ao processo) ────────────────────────────────────────────
interface QaMessage { role: "user" | "assistant"; content: string; ts: number; }

function useQa(processId: string | null) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Carrega histórico persistido
  useEffect(() => {
    if (!processId) { setMessages([]); return; }
    const key = `qa_${processId}`;
    chrome.storage.local.get(key, (r) => setMessages((r[key] as QaMessage[]) ?? []));
  }, [processId]);

  function persist(msgs: QaMessage[]) {
    setMessages(msgs);
    if (processId) chrome.storage.local.set({ [`qa_${processId}`]: msgs });
  }

  function ask(question: string) {
    const q = question.trim();
    if (!processId || !q || loading) return;

    const withUser = [...messages, { role: "user" as const, content: q, ts: Date.now() }];
    persist(withUser);
    setLoading(true); setError(null);

    // Envia histórico anterior (sem timestamps) para follow-up coerente
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    chrome.runtime.sendMessage(
      { type: "ASK_PROCESS", payload: { processId, question: q, history } },
      (res) => {
        setLoading(false);
        if (res?.ok) {
          persist([...withUser, { role: "assistant", content: res.answer, ts: Date.now() }]);
        } else {
          setError(res?.error ?? "Erro ao consultar a IA.");
        }
      }
    );
  }

  function clear() { persist([]); }

  return { messages, loading, error, ask, clear };
}

// ─── Hook: config de IA ─────────────────────────────────────────────────────────
function useAiConfig() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [legada, setLegada] = useState(false);
  const [pronto, setPronto] = useState(false); // config null = "sem chave" só depois de ler o storage

  useEffect(() => {
    chrome.storage.local.get("aiConfig", (r) => { setConfig(normalizarConfig(r.aiConfig)); setLegada(configLegada(r.aiConfig)); setPronto(true); });
  }, []);

  function save(cfg: AiConfig) {
    chrome.storage.local.set({ aiConfig: cfg });
    setConfig(cfg);
  }

  return { config, legada, pronto, save };
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
function atras(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `há ${d} dia${d > 1 ? "s" : ""}`;
}

// ─── Componentes ────────────────────────────────────────────────────────────────

function IdleScreen() {
  return (
    <div className="screen screen--idle">
      <div className="idle-icon">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="4 3"/>
          <path d="M13 20h14M20 13v14" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </div>
      <p className="idle-title">Entre no SEI para começar</p>
      <p className="idle-desc">O assistente funciona junto com o SEI do TJPE: faça login em sei.cloud.tjpe.jus.br nesta janela.</p>
      <p className="idle-hint">Já entrou? Recarregue a página do SEI (F5).</p>
    </div>
  );
}

// ── Tela: Configurações ─────────────────────────────────────────────────────────
function SettingsScreen({ onBack, onControlador }: { onBack: () => void; onControlador: () => void }) {
  const { config, legada, save } = useAiConfig();
  const [apiKey, setApiKey] = useState("");
  const [ver, setVer] = useState(false);
  const [model, setModel] = useState(MODELO_PADRAO);
  const [saved, setSaved] = useState(false);
  const [dev, setDev] = useState(false);

  // config chega assíncrona do storage
  useEffect(() => { if (config) { setApiKey(config.apiKey); setModel(config.model); } }, [config]);
  useEffect(() => { chrome.storage.local.get("modoDev", (r) => setDev(!!r.modoDev)); }, []);

  function handleSave() {
    save({ provider: "tjpe", apiKey: apiKey.trim(), model, baseUrl: LITELLM_URL });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }
  const conectado = !!config?.apiKey && !legada;

  return (
    <div className="screen screen--active">
      <ScreenHeader title="Configurações" onBack={onBack} />

      <div className="settings-body">
        <section className="set-card">
          <div className="set-card-head">
            <span className="set-card-title"><Icon n="chave" /> Conexão com a IA</span>
            <span className={`pill ${conectado ? "pill--ok" : "pill--warn"}`}>{conectado ? "Configurada" : "Pendente"}</span>
          </div>
          <p className="set-help">Resumo, auditoria, perguntas e revisão usam a IA do tribunal. Cole aqui a sua chave de acesso — ela fica salva só neste navegador.</p>
          {legada && <p className="aviso aviso--warn"><Icon n="alerta" /> A chave salva era de outro serviço (Groq/OpenAI). Cole a chave do LiteLLM do TJPE.</p>}
          <label className="settings-label" htmlFor="set-key">Chave de acesso</label>
          <div className="set-key">
            <input id="set-key" className="settings-input" type={ver ? "text" : "password"} placeholder="sk-…" autoComplete="off" spellCheck={false}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className="btn-icon btn-icon--soft" onClick={() => setVer((v) => !v)} aria-label={ver ? "Esconder chave" : "Mostrar chave"} title={ver ? "Esconder" : "Mostrar"}>
              <Icon n={ver ? "olhoOff" : "olho"} />
            </button>
          </div>
          <p className="set-help set-help--small">Não tem? Gere em <strong>litellm.cloud.tjpe.jus.br</strong> ou peça à equipe responsável.</p>
          <button className="btn btn--primary btn--block" onClick={handleSave} disabled={!apiKey.trim()}>
            {saved ? <><Icon n="ok" /> Salvo</> : "Salvar"}
          </button>
        </section>

        <details className="set-card set-avancado">
          <summary><Icon n="ajustes" /> Opções avançadas</summary>
          <label className="settings-label" htmlFor="set-modelo">Modelo do resumo, auditoria e perguntas</label>
          <select id="set-modelo" className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELOS.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
          <p className="set-help set-help--small">Os agentes de revisão escolhem o modelo sozinhos. Mudou o modelo? Clique em Salvar acima.</p>

          <button className="set-link" onClick={onControlador}>
            <span><b>Controlador dos agentes</b><small>Ajustes automáticos feitos a partir das avaliações</small></span><Icon n="seguir" />
          </button>
          <label className="settings-check">
            <input type="checkbox" checked={dev} onChange={(e) => { setDev(e.target.checked); chrome.storage.local.set({ modoDev: e.target.checked }); }} />
            <span>Modo desenvolvedor — mostra as estatísticas de evolução e custo dos agentes na tela inicial.</span>
          </label>
        </details>
      </div>
    </div>
  );
}


// ── Componente: Progress Bar de Coleta ─────────────────────────────────────────
function CollectionProgressBar({
  progress,
  onStart,
  onStop,
  onReset,
  hasData,
  timeAgo,
}: {
  progress: CollectionProgress | null;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  hasData: boolean;
  timeAgo?: string | null;
}) {
  if (progress?.status === "running") {
    const pct = Math.round((progress.step / progress.totalSteps) * 100);
    const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);
    return (
      <div className="collect-bar collect-bar--running" role="status">
        <div className="collect-phase">
          <span className="collect-spinner" />
          <span>{progress.phase}</span>
        </div>
        <div className="collect-progress-track">
          <div className="collect-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="collect-meta">
          <span>Etapa {progress.step} de {progress.totalSteps} · {elapsed}s</span>
          <button className="btn-link btn-link--danger" onClick={onStop}>Parar</button>
        </div>
      </div>
    );
  }

  if (progress?.status === "error") {
    return (
      <div className="collect-bar">
        <p className="aviso aviso--erro"><Icon n="alerta" /> {progress.phase}</p>
        <div className="row">
          <button className="btn btn--primary" onClick={onStart}>Tentar novamente</button>
          <button className="btn btn--ghost" onClick={onReset}>Fechar</button>
        </div>
      </div>
    );
  }

  // Ainda sem dados: o primeiro passo fica bem explicado
  if (!hasData) {
    return (
      <div className="collect-bar collect-bar--first">
        <p className="collect-first-title">Primeiro passo: ler o processo</p>
        <p className="collect-first-desc">A extensão abre a árvore do processo no SEI e lê os despachos e o andamento. Leva cerca de 1 minuto — não feche a aba do SEI.</p>
        <button className="btn btn--primary btn--block" onClick={onStart}><Icon n="play" s={14} /> Ler o processo</button>
      </div>
    );
  }

  return (
    <div className="collect-line">
      <span className="collect-line-txt">
        {progress?.status === "done" ? <><Icon n="ok" s={14} className="txt-ok" /> Dados atualizados agora</> : <>Dados lidos {timeAgo ?? ""}</>}
      </span>
      <button className="btn-link" onClick={onStart}><Icon n="atualizar" s={13} /> Ler de novo</button>
    </div>
  );
}

// ── Componente: Tramitação (linha do tempo por unidade) ─────────────────────────
const dias = (n: number) => `${n} dia${n === 1 ? "" : "s"}`;

function TramitacaoPanel({ details, onAtualizar, atualizando, aguardandoSei, erro }: {
  details: ProcessDetails; onAtualizar: () => void; atualizando: boolean; aguardandoSei: boolean; erro: string | null;
}) {
  const [abertos, setAbertos] = useState<Record<number, boolean>>({});
  const phases = buildTramitacao(details);
  const hasAndamento = details.andamento.length > 0;
  const totalDays = phases.reduce((acc, p) => acc + (p.durationDays ?? 0), 0);
  const atual = phases.find((p) => p.isCurrent);
  // fase mais demorada (fora a atual, que ainda está correndo) = provável gargalo
  const maisLonga = phases.length > 2
    ? phases.filter((p) => !p.isCurrent && (p.durationDays ?? 0) > 0).sort((a, b) => (b.durationDays ?? 0) - (a.durationDays ?? 0))[0]
    : undefined;

  const aviso = (
    <>
      {aguardandoSei && (
        <div className="aviso aviso--info" role="status">
          <span className="collect-spinner" />
          <span>No SEI, clique em <strong>Consultar Andamento</strong> dentro do processo. As datas são lidas sozinhas assim que a página abrir.</span>
        </div>
      )}
      {erro && !aguardandoSei && <p className="aviso aviso--erro"><Icon n="alerta" /> {erro}</p>}
    </>
  );

  return (
    <div className="tram">
      {!hasAndamento && (
        <div className="tram-vazio">
          <Icon n="caminho" s={26} />
          <p className="tram-vazio-tit">Por onde o processo passou</p>
          <p className="tram-vazio-txt">Mostra cada unidade, quanto tempo o processo ficou lá e os despachos de cada uma. Para ver as datas, a extensão precisa ler o histórico de andamento do SEI.</p>
          {aviso}
          <button className="btn btn--primary btn--block" onClick={onAtualizar} disabled={atualizando}>
            {atualizando ? "Aguardando o SEI…" : <><Icon n="relogio" s={15} /> Buscar datas do andamento</>}
          </button>
        </div>
      )}
      {!hasAndamento && phases.length > 0 && <p className="tram-sub">Unidades identificadas pelos despachos (ainda sem datas):</p>}
      {hasAndamento && atual && (
        <section className="tram-agora">
          <p className="tram-agora-rot">{atual.concluded ? "Concluído em" : "Está agora em"}</p>
          <p className="tram-agora-unid">{atual.unit}</p>
          <p className="tram-agora-meta">
            {!atual.concluded && atual.durationDays !== null && <><b className={atual.durationDays > 30 ? "txt-alerta" : ""}>há {dias(atual.durationDays)}</b> · </>}
            {dias(totalDays)} no total · {phases.length} unidade{phases.length === 1 ? "" : "s"}
          </p>
        </section>
      )}
      {hasAndamento && aviso}

      {phases.length > 0 && <ol className="tram-lista">
        {phases.map((phase, i) => {
          const aberto = abertos[i] ?? phase.isCurrent;
          const pct = totalDays > 0 && phase.durationDays !== null ? Math.round((phase.durationDays / totalDays) * 100) : null;
          return (
            <li key={i} className={`tram-fase ${phase.isCurrent ? "tram-fase--atual" : ""}`}>
              <span className="tram-marco" aria-hidden="true" />
              <div className="tram-fase-corpo">
                <div className="tram-fase-topo">
                  <span className="tram-fase-unid">{phase.unit}</span>
                  {phase.concluded ? <span className="pill pill--ok">concluído</span>
                    : phase.durationDays !== null && <span className={`tram-dias ${phase.isCurrent ? "tram-dias--atual" : ""}`}>{dias(phase.durationDays)}</span>}
                </div>
                <div className="tram-fase-datas">
                  {phase.enteredAt && <span>entrou {fmtDate(phase.enteredAt)}</span>}
                  {phase.leftAt && <span>saiu {fmtDate(phase.leftAt)}</span>}
                  {phase === maisLonga && <span className="tram-gargalo">etapa mais demorada</span>}
                </div>
                {pct !== null && (
                  <div className="tram-barra" title={`${pct}% do tempo total`}><span style={{ width: `${Math.max(pct, 2)}%` }} /></div>
                )}
                {phase.despachos.length > 0 && (
                  <>
                    <button className="btn-link tram-desp-btn" onClick={() => setAbertos((p) => ({ ...p, [i]: !aberto }))} aria-expanded={aberto}>
                      <Icon n="seguir" s={12} className={aberto ? "rot-90b" : ""} /> {phase.despachos.length} despacho{phase.despachos.length === 1 ? "" : "s"}
                    </button>
                    {aberto && (
                      <ul className="tram-despachos">
                        {phase.despachos.map((d, j) => (
                          <li key={j} className="tram-despacho-item">
                            <span className="tram-despacho-title">{d.title.replace(/despacho\s+\d+\s*/i, "").trim() || d.title}</span>
                            <span className="tram-despacho-id">{d.docId ? `nº ${d.docId}` : ""}{d.date ? ` · ${fmtDate(d.date)}` : ""}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>}

      {hasAndamento && (
        <button className="btn-link tram-atualizar" onClick={onAtualizar} disabled={atualizando}>
          <Icon n="atualizar" s={13} /> {atualizando ? "Aguardando o SEI…" : "Atualizar datas do andamento"}
        </button>
      )}
    </div>
  );
}

// ── Componente: Painel de Auditoria ─────────────────────────────────────────────

const SEVERITY_META: Record<AuditSeverity, { label: string; cls: string; icon: string }> = {
  critico: { label: "Crítico", cls: "sev--critico", icon: "⛔" },
  alto:    { label: "Alto",    cls: "sev--alto",    icon: "⚠️" },
  medio:   { label: "Médio",   cls: "sev--medio",   icon: "△" },
  baixo:   { label: "Baixo",   cls: "sev--baixo",   icon: "ℹ️" },
  ok:      { label: "OK",      cls: "sev--ok",      icon: "✓" },
};

const RISK_META: Record<AuditSeverity, { label: string; cls: string }> = {
  critico: { label: "Risco Crítico", cls: "risk--critico" },
  alto:    { label: "Risco Alto",    cls: "risk--alto" },
  medio:   { label: "Risco Médio",   cls: "risk--medio" },
  baixo:   { label: "Conforme",      cls: "risk--baixo" },
  ok:      { label: "Conforme",      cls: "risk--baixo" },
};

const CATEGORY_LABEL: Record<string, string> = {
  documental: "Documental",
  temporal: "Prazos",
  processual: "Sequência",
  financeiro: "Financeiro",
  conformidade: "Conformidade",
};

function AuditPanel({
  audit,
  auditing,
  error,
  onRun,
  hasData,
  hasApiKey,
}: {
  audit: AuditResult | null;
  auditing: boolean;
  error: string | null;
  onRun: () => void;
  hasData: boolean;
  hasApiKey: boolean;
}) {
  if (auditing) {
    return (
      <div className="audit-loading" role="status">
        <span className="collect-spinner" />
        <span>Conferindo documentos, prazos e sequência dos atos… (cerca de 20 s)</span>
      </div>
    );
  }

  if (!audit) {
    return (
      <div className="audit-empty">
        <Icon n="escudo" s={26} />
        <p className="audit-empty-title">Auditoria de conformidade</p>
        <p className="audit-empty-desc">Dá uma nota de 0 a 100 ao processo e mostra o que precisa de atenção:</p>
        <ul className="audit-empty-lista">
          <li><Icon n="doc" s={14} /> documentos obrigatórios que faltam para a fase atual</li>
          <li><Icon n="relogio" s={14} /> prazos estourados e processo parado</li>
          <li><Icon n="caminho" s={14} /> atos fora de ordem (ex.: contrato antes do parecer)</li>
        </ul>
        {!hasData && <p className="aviso aviso--warn"><Icon n="alerta" /> Leia o processo primeiro (botão acima) para uma análise completa.</p>}
        {!hasApiKey && <p className="audit-empty-hint">Sem a chave da IA, roda só com as verificações automáticas (sem o parecer escrito).</p>}
        {error && <p className="aviso aviso--erro"><Icon n="alerta" /> {error}</p>}
        <button className="btn btn--primary btn--block" onClick={onRun}><Icon n="escudo" s={15} /> Auditar processo</button>
      </div>
    );
  }

  const risk = RISK_META[audit.riskLevel];
  const order: AuditSeverity[] = ["critico", "alto", "medio", "baixo"];
  const bySev = (a: AuditFinding, b: AuditFinding) => order.indexOf(a.severity) - order.indexOf(b.severity);
  const ruleFindings = audit.findings.filter((f) => f.source === "regra").sort(bySev);
  const iaFindings = audit.findings.filter((f) => f.source === "ia").sort(bySev);
  const faltando = audit.checklist.filter((c) => c.status === "ausente").sort((a, b) => Number(b.critical) - Number(a.critical));
  const presentes = audit.checklist.filter((c) => c.status === "presente");
  const futuros = audit.checklist.filter((c) => c.status === "na");
  const obrigFaltando = faltando.filter((c) => c.critical).length;

  // frase-resumo em linguagem simples
  const partes: string[] = [];
  if (obrigFaltando) partes.push(`${obrigFaltando} documento${obrigFaltando > 1 ? "s" : ""} obrigatório${obrigFaltando > 1 ? "s" : ""} faltando`);
  if (ruleFindings.length) partes.push(`${ruleFindings.length} ponto${ruleFindings.length > 1 ? "s" : ""} de atenção`);
  const frase = partes.length ? partes.join(" e ") : "Nada pendente para a fase atual";

  const bd = audit.breakdown;
  const genStr = new Date(audit.generatedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const corNota = `var(--sev-${audit.riskLevel === "ok" ? "ok" : audit.riskLevel === "baixo" ? "ok" : audit.riskLevel})`;

  return (
    <div className="audit-panel">
      <section className={`audit-scorecard ${risk.cls}`}>
        <div className="audit-score-ring" style={{ background: `conic-gradient(${corNota} ${audit.score * 3.6}deg, var(--color-border) 0)` }}
          role="img" aria-label={`Nota ${audit.score} de 100`}>
          <span className="audit-score-in"><span className="audit-score-num">{audit.score}</span><span className="audit-score-max">de 100</span></span>
        </div>
        <div className="audit-score-info">
          <span className={`audit-risk-badge ${risk.cls}`}>{risk.label}</span>
          <span className="audit-frase">{frase}</span>
          {audit.stageLabel && <span className="audit-stage">Fase: {audit.stageLabel}</span>}
        </div>
      </section>

      {audit.aiSummary && (
        <div className="audit-summary">
          <p className="audit-section-label">Parecer</p>
          <p className="audit-summary-text">{audit.aiSummary}</p>
        </div>
      )}

      <div className="audit-block">
        <p className="audit-section-label">Pontos de atenção <span className="audit-n">{ruleFindings.length}</span></p>
        {ruleFindings.length === 0 ? (
          <div className="audit-no-findings"><Icon n="ok" s={14} /> Nenhuma irregularidade objetiva encontrada.</div>
        ) : (
          <div className="audit-findings">
            {ruleFindings.map((f, i) => <AuditFindingCard key={i} finding={f} />)}
          </div>
        )}
      </div>

      <div className="audit-block">
        <p className="audit-section-label">Documentos <span className="audit-n">{presentes.length} de {presentes.length + faltando.length}</span></p>
        {faltando.length > 0 && <>
          <p className="audit-sub">Faltando</p>
          <ul className="audit-checklist">
            {faltando.map((c, i) => (
              <li key={i} className="audit-check audit-check--ausente">
                <span className={`audit-check-icon ${c.critical ? "is-crit" : ""}`}><Icon n="fechar" s={11} /></span>
                <span className="audit-check-label">{c.label}{c.critical && <span className="audit-check-tag">obrigatório</span>}</span>
              </li>
            ))}
          </ul>
        </>}
        {presentes.length > 0 && <>
          <p className="audit-sub">No processo</p>
          <ul className="audit-checklist">
            {presentes.map((c, i) => (
              <li key={i} className="audit-check audit-check--presente" title={c.docRef ?? ""}>
                <span className="audit-check-icon"><Icon n="ok" s={11} /></span>
                <span className="audit-check-label">{c.label}</span>
              </li>
            ))}
          </ul>
        </>}
        {futuros.length > 0 && (
          <details className="audit-futuros">
            <summary>{futuros.length} documento{futuros.length > 1 ? "s" : ""} de fases seguintes (não contam na nota)</summary>
            <ul className="audit-checklist">
              {futuros.map((c, i) => (
                <li key={i} className="audit-check audit-check--na">
                  <span className="audit-check-icon"><Icon n="relogio" s={11} /></span>
                  <span className="audit-check-label">{c.label}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {iaFindings.length > 0 && (
        <div className="audit-block">
          <p className="audit-section-label">Observações da IA <span className="audit-n">{iaFindings.length}</span></p>
          <p className="audit-ia-note">Análise do texto dos documentos — não muda a nota. Confira na fonte.</p>
          <div className="audit-findings">
            {iaFindings.map((f, i) => <AuditFindingCard key={i} finding={f} />)}
          </div>
        </div>
      )}

      {bd && (
        <details className="audit-como">
          <summary>Como a nota foi calculada</summary>
          <div className="audit-breakdown">
            <span className="audit-bd-base">100</span>
            {bd.penalidadeDocumentos > 0 && (
              <span className="audit-bd-item">− {bd.penalidadeDocumentos} <small>({bd.docsObrigatoriosAusentes} obrigatório(s) + {bd.docsOpcionaisAusentes} opcional(is) faltando)</small></span>
            )}
            {bd.penalidadeAchados > 0 && (
              <span className="audit-bd-item">− {bd.penalidadeAchados} <small>({bd.achadosRegra} ponto(s) de atenção)</small></span>
            )}
            <span className="audit-bd-eq">= {audit.score}</span>
          </div>
          {audit.stageLabel && <p className="audit-stage-note">Só contam os documentos esperados até a fase atual ({audit.stageLabel.toLowerCase()}). Observações da IA não mudam a nota.</p>}
        </details>
      )}

      <div className="audit-footer">
        <span>Auditado em {genStr}</span>
        <button className="btn-link" onClick={onRun}><Icon n="atualizar" s={13} /> Auditar de novo</button>
      </div>
    </div>
  );
}

function AuditFindingCard({ finding }: { finding: AuditFinding }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY_META[finding.severity];
  return (
    <div className={`audit-finding ${meta.cls}`}>
      <button className="audit-finding-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="audit-finding-title">{finding.title}</span>
        <span className="audit-finding-chevron"><Icon n="seguir" s={13} className={open ? "rot-90b" : ""} /></span>
      </button>
      <div className="audit-finding-tags">
        <span className={`audit-sev ${meta.cls}`}>{meta.label}</span>
        <span className="audit-finding-cat">{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
      </div>
      {open && (
        <div className="audit-finding-body">
          <p className="audit-finding-desc">{finding.description}</p>
          {finding.recommendation && (
            <p className="audit-finding-rec"><strong>O que fazer:</strong> {finding.recommendation}</p>
          )}
          <span className="audit-finding-source">{finding.source === "ia" ? "Análise da IA" : "Regra automática"}</span>
        </div>
      )}
    </div>
  );
}

// ── Componente: Painel de Q&A (pergunte ao processo) ────────────────────────────

const QA_SUGGESTIONS = [
  "Qual o objeto e o valor do processo?",
  "Quem autorizou e em que data?",
  "Há parecer jurídico? Foi favorável?",
  "Qual o status atual e o que falta?",
  "Quem é o fornecedor/contratado?",
];

function QaPanel({
  processId,
  hasData,
  hasApiKey,
  onSettings,
}: {
  processId: string;
  hasData: boolean;
  hasApiKey: boolean;
  onSettings: () => void;
}) {
  const { messages, loading, error, ask, clear } = useQa(processId);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q) return;
    ask(q);
    setInput("");
  }

  if (!hasApiKey) {
    return (
      <div className="qa-empty">
        <p className="qa-empty-title">Pergunte ao processo</p>
        <p className="qa-empty-desc">Configure uma chave de IA para conversar sobre o conteúdo do processo.</p>
        <button className="btn-config-link" onClick={onSettings}>Configurar agora →</button>
      </div>
    );
  }

  return (
    <div className="qa-panel">
      <div className="qa-messages" ref={scrollRef}>
        {messages.length === 0 && !loading && (
          <div className="qa-intro">
            <p className="qa-intro-text">
              {hasData
                ? "Pergunte qualquer coisa sobre este processo. As respostas usam os documentos e o histórico coletados."
                : "Leia o processo primeiro (botão acima) para respostas completas. Dá para perguntar mesmo assim, mas a IA terá pouco contexto."}
            </p>
            <div className="qa-suggestions">
              {QA_SUGGESTIONS.map((s, i) => (
                <button key={i} className="qa-suggestion" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`qa-msg qa-msg--${m.role}`}>
            <div className="qa-bubble">{m.content}</div>
          </div>
        ))}

        {loading && (
          <div className="qa-msg qa-msg--assistant">
            <div className="qa-bubble qa-bubble--loading">
              <span className="qa-dot" /><span className="qa-dot" /><span className="qa-dot" />
            </div>
          </div>
        )}

        {error && <div className="summary-error summary-error--inline"><p>{error}</p></div>}
      </div>

      <div className="qa-inputbar">
        {messages.length > 0 && (
          <button className="qa-clear" onClick={clear} title="Limpar conversa" aria-label="Limpar conversa"><Icon n="lixo" s={15} /></button>
        )}
        <textarea
          className="qa-input"
          placeholder="Pergunte sobre o processo…"
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={loading}
        />
        <button className="qa-send" onClick={() => send()} disabled={loading || !input.trim()} aria-label="Enviar pergunta"><Icon n="enviar" s={15} /></button>
      </div>
    </div>
  );
}

// ── Renderer do resumo da IA ────────────────────────────────────────────────────
// Suporta: **Heading**, separadores ────, bullets (•, →, -), linhas em branco.
// Para bullets "campo: valor", destaca o label em negrito leve.

const BULLET_RE = /^([•→\-*])\s+(.*)$/;
const LABEL_RE  = /^([^:]{2,40}):\s*(.+)$/;
const SEP_RE    = /^[─━_=]{3,}$/;

function renderSummary(text: string) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") { out.push(<div key={i} className="summary-gap" />); return; }
    if (SEP_RE.test(line)) { out.push(<hr key={i} className="summary-sep" />); return; }

    // Heading: **Titulo**
    if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
      out.push(<p key={i} className="summary-heading">{line.replace(/\*\*/g, "")}</p>);
      return;
    }

    // Bullet: • / → / -
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      const marker = bullet[1] === "→" ? "→" : "•";
      const rest = bullet[2];
      const label = rest.match(LABEL_RE);
      out.push(
        <div key={i} className="summary-bullet">
          <span className="summary-bullet-marker">{marker}</span>
          <span className="summary-bullet-text">
            {label ? <><strong className="summary-bullet-label">{label[1]}:</strong> {label[2]}</> : rest}
          </span>
        </div>
      );
      return;
    }

    out.push(<p key={i} className="summary-line">{line}</p>);
  });

  return <>{out}</>;
}

const DETAIL_TABS: { id: DetailTab; label: string; icon: NomeIcone }[] = [
  { id: "resumo", label: "Resumo", icon: "resumo" },
  { id: "tramitacao", label: "Tramitação", icon: "caminho" },
  { id: "auditoria", label: "Auditoria", icon: "escudo" },
  { id: "perguntar", label: "Perguntar", icon: "conversa" },
  { id: "revisao", label: "Revisar", icon: "revisar" },
];

// ── Tela: Detalhe do processo ───────────────────────────────────────────────────
// Hook: alerta de movimentação (flag moved_${id} gravada pelo content script
// quando um processo já coletado ganha andamento/documentos novos)
function useMoved(processId: string) {
  const [moved, setMoved] = useState<{ count: number; at: number } | null>(null);
  useEffect(() => {
    const key = `moved_${processId}`;
    chrome.storage.local.get(key, (r) => setMoved((r[key] as { count: number; at: number }) ?? null));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c[key]) setMoved((c[key].newValue as { count: number; at: number }) ?? null);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [processId]);
  function dismiss() {
    chrome.storage.local.remove(`moved_${processId}`);
    setMoved(null);
  }
  return { moved, dismiss };
}

// Hook: conjunto de processos com movimentação pendente (para o portfólio)
function useMovedIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = () => chrome.storage.local.get(null, (all) => {
      setIds(new Set(Object.keys(all).filter((k) => k.startsWith("moved_")).map((k) => k.slice("moved_".length))));
    });
    load();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("moved_"))) load();
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  return ids;
}

function ProcessDetailScreen({
  processId,
  onBack,
  onSettings,
}: {
  processId: string;
  onBack: () => void;
  onSettings: () => void;
}) {
  const { moved, dismiss: dismissMoved } = useMoved(processId);
  const { details, summarizing, summaryError, generateSummary } = useProcessDetails(processId);
  const { progress: collectProgress, startCollection, stopCollection, reset: resetCollection } = useCollectionProgress(processId);
  const { audit, auditing, error: auditError, runAudit } = useAudit(processId, details);
  const { config } = useAiConfig();
  const hasApiKey = !!config?.apiKey;
  const hasData = !!(details?.documents?.length || details?.andamento?.length);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<DetailTab>("resumo");
  const [expanding, setExpanding] = useState(false);
  const [generatingTram, setGeneratingTram] = useState(false);
  const [tramError, setTramError] = useState<string | null>(null);
  const [waitingForSei, setWaitingForSei] = useState(false);

  // Quando andamento chega via storage.onChanged enquanto aguardando, limpa o loading
  useEffect(() => {
    if (waitingForSei && (details?.andamento?.length ?? 0) > 0) {
      setGeneratingTram(false);
      setWaitingForSei(false);
      setTramError(null);
    }
  }, [details?.andamento?.length, waitingForSei]);

  function generateTramitacao() {
    setGeneratingTram(true); setTramError(null); setWaitingForSei(false);
    chrome.runtime.sendMessage(
      { type: "GET_ANDAMENTO", payload: { processId } },
      (res) => {
        if (res?.ok) {
          // Andamento já estava no storage — loading pode parar
          setGeneratingTram(false);
          setWaitingForSei(false);
        } else {
          // Sem andamento: mantém loading e avisa para abrir o SEI
          setWaitingForSei(true);
          setTramError(res?.error ?? "Não foi possível buscar o histórico.");
        }
      }
    );
  }


  function expandTree() {
    setExpanding(true);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { setExpanding(false); return; }
      // Sem frameId → todos os frames recebem (all_frames: true no content script)
      chrome.tabs.sendMessage(tabId, { type: "EXPAND_TREE" }, () => {
        if (chrome.runtime.lastError) { /* ignora se nenhum frame responder */ }
        setTimeout(() => setExpanding(false), 3000);
      });
    });
  }

  function exportDossie() {
    const url = chrome.runtime.getURL("dist/report.html") + "?id=" + encodeURIComponent(processId);
    chrome.tabs.create({ url });
  }

  const timeAgo = details?.extractedAt ? atras(details.extractedAt) : null;

  return (
    <div className="screen screen--active detail-screen">
      <ScreenHeader title={processId} sub={details?.type} onBack={onBack}>
        {details && (
          <button className="btn-refresh" title="Exportar dossiê (PDF / Word)" aria-label="Exportar dossiê" onClick={exportDossie}>
            <Icon n="baixar" s={17} />
          </button>
        )}
        <button className="btn-refresh" title="Expandir todas as pastas da árvore no SEI" aria-label="Expandir pastas da árvore" onClick={expandTree} disabled={expanding}>
          {expanding ? <span className="collect-spinner collect-spinner--light" /> : <Icon n="pasta" s={17} />}
        </button>
      </ScreenHeader>

      {!details && (
        <div className="detail-waiting">
          <Icon n="doc" s={28} />
          <p className="detail-waiting-title">Ainda não li este processo</p>
          <p className="detail-waiting-desc">
            Clique abaixo e a extensão abre o processo <strong>{processId}</strong> no SEI e lê os documentos sozinha.
          </p>
          <CollectionProgressBar progress={collectProgress} onStart={startCollection} onStop={stopCollection} onReset={resetCollection} hasData={false} />
        </div>
      )}

      {details && (
        <div className="detail-body">
          {/* Alerta de movimentação desde a última coleta */}
          {moved && (
            <div className="moved-banner">
              <span className="moved-text">
                <Icon n="sino" s={14} /> <span><b>{moved.count} novidade{moved.count > 1 ? "s" : ""}</b> no SEI desde a última leitura — o resumo pode estar desatualizado.</span>
              </span>
              <span className="moved-actions">
                <button className="moved-btn" onClick={startCollection}>Ler de novo</button>
                <button className="moved-dismiss" onClick={dismissMoved} aria-label="Dispensar aviso" title="Dispensar aviso"><Icon n="fechar" s={12} /></button>
              </span>
            </div>
          )}

          {/* Coleta guiada */}
          <CollectionProgressBar
            progress={collectProgress}
            onStart={startCollection}
            onStop={stopCollection}
            onReset={resetCollection}
            hasData={hasData}
            timeAgo={timeAgo}
          />

          {/* Abas */}
          <div className="detail-tabs" role="tablist">
            {DETAIL_TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} aria-label={t.label}
                className={`detail-tab ${tab === t.id ? "detail-tab--active" : ""}`} onClick={() => setTab(t.id)}>
                <Icon n={t.icon} s={15} />
                <span>{t.label}</span>
                {t.id === "auditoria" && audit && <span className={`detail-tab-dot ${RISK_META[audit.riskLevel].cls}`} />}
              </button>
            ))}
          </div>

          {/* Aba: Revisão por agentes */}
          {tab === "revisao" && (
            <RevisaoPanel processId={processId} hasApiKey={hasApiKey} onSettings={onSettings} />
          )}

          {/* Aba: Auditoria */}
          {tab === "auditoria" && (
            <AuditPanel
              audit={audit}
              auditing={auditing}
              error={auditError}
              onRun={runAudit}
              hasData={hasData}
              hasApiKey={hasApiKey}
            />
          )}

          {/* Aba: Perguntar */}
          {tab === "perguntar" && (
            <QaPanel
              processId={processId}
              hasData={hasData}
              hasApiKey={hasApiKey}
              onSettings={onSettings}
            />
          )}

          {/* Aba: Tramitação */}
          {tab === "tramitacao" && (
            <>
              <TramitacaoPanel details={details} onAtualizar={generateTramitacao} atualizando={generatingTram}
                aguardandoSei={waitingForSei} erro={tramError} />
            </>
          )}

          {/* Aba: Resumo — conteúdo original */}
          {tab === "resumo" && <>
          {/* Resumo IA */}
          <div className="detail-section" ref={summaryRef}>
            <p className="detail-section-title">Resumo com IA</p>

            {!hasApiKey && (
              <div className="summary-no-key">
                <p>Falta configurar a chave da IA.</p>
                <button className="btn-config-link" onClick={onSettings}>
                  Configurar agora →
                </button>
              </div>
            )}

            {hasApiKey && !details.summary && !summarizing && (
              <button className="btn btn--primary btn--block" onClick={generateSummary}>
                <Icon n="resumo" s={15} /> Gerar resumo
              </button>
            )}

            {summarizing && (
              <div className="summary-loading"><span className="collect-spinner" /> Gerando resumo… (cerca de 20 s)</div>
            )}

            {summaryError && (
              <div className="summary-error">
                <p>{summaryError}</p>
                <button className="btn-summarize btn-summarize--retry" onClick={generateSummary}>
                  Tentar novamente
                </button>
              </div>
            )}

            {details.summary && !summarizing && (
              <div className="summary-content">
                {renderSummary(details.summary)}
                <button className="btn-summarize btn-summarize--retry" onClick={generateSummary}>
                  <Icon n="atualizar" s={13} /> Gerar de novo
                </button>
              </div>
            )}
          </div>


          {/* Metadados */}
          <div className="detail-meta">
          {details.type && <div className="detail-field"><span className="detail-key">Tipo</span><span className="detail-val">{details.type}</span></div>}
          {details.description && <div className="detail-field"><span className="detail-key">Especificação</span><span className="detail-val">{details.description}</span></div>}
          {details.currentUnit && <div className="detail-field"><span className="detail-key">Unidade</span><span className="detail-val">{details.currentUnit}</span></div>}
          {details.parties.length > 0 && (
            <div className="detail-field"><span className="detail-key">Interessados</span><span className="detail-val">{details.parties.join(", ")}</span></div>
          )}
          </div>

          {/* Andamento */}
          {details.andamento.length > 0 && (
            <div className="detail-section">
              <p className="detail-section-title">Últimos andamentos</p>
              {details.andamento.slice(0, 5).map((a, i) => (
                <div key={i} className="andamento-item">
                  <span className="andamento-date">{a.date}</span>
                  <span className="andamento-desc">{a.description}</span>
                  {a.unit && <span className="andamento-unit">{a.unit}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Documentos-chave (Termo de Referência, Contrato, Parecer…) */}
          {(() => {
            const keyDocs = extractImportantDocs(details.documents);
            if (keyDocs.length === 0) return null;
            return (
              <div className="detail-section">
                <p className="detail-section-title">Documentos-chave ({keyDocs.length})</p>
                <ul className="keydoc-list">
                  {keyDocs.slice(0, 10).map((d, i) => (
                    <li key={i} className={`keydoc ${d.priority === 1 ? "keydoc--top" : ""}`}>
                      <span className="keydoc-cat">{d.category}</span>
                      <span className="keydoc-title">{cleanDocTitle(d.title) || d.title}</span>
                      {d.docId && <span className="keydoc-id">#{d.docId}</span>}
                    </li>
                  ))}
                </ul>
                {keyDocs.length > 10 && <p className="keydoc-more">+{keyDocs.length - 10} outros</p>}
              </div>
            );
          })()}

          {/* Documentos — Despachos */}
          {details.documents.length > 0 && (() => {
            const despachos = details.documents.filter(d => /^despacho\s+\d+/i.test(d));
            const outros = details.documents.filter(d => !/^despacho\s+\d+/i.test(d));
            return (
              <>
                {despachos.length > 0 && (
                  <div className="detail-section">
                    <p className="detail-section-title">Despachos ({despachos.length})</p>
                    <p className="detail-docs">{despachos.join(" · ")}</p>
                  </div>
                )}
                {outros.length > 0 && (
                  <div className="detail-section">
                    <p className="detail-section-title">Outros documentos ({outros.length})</p>
                    <p className="detail-docs">{outros.slice(0, 10).join(" · ")}{outros.length > 10 ? ` · +${outros.length - 10} mais` : ""}</p>
                  </div>
                )}
              </>
            );
          })()}

          {/* Diagnóstico de leitura de conteúdo */}
          {(() => {
            const content = details.despachosContent ?? "";
            const nDocs = (content.match(/^===\s/gm) || []).length;
            const chars = content.length;
            const ok = chars > 300;
            return (
              <div className={`read-status ${ok ? "read-status--ok" : "read-status--warn"}`}>
                {ok
                  ? `${nDocs} documento(s) lido(s) · ${(chars / 1000).toFixed(1)} mil caracteres`
                  : "Pouco conteúdo de documento lido — clique em “Ler de novo” ou abra os despachos no SEI."}
              </div>
            );
          })()}

          </> /* fim aba resumo */}
        </div>
      )}
    </div>
  );
}

// ── Tela: Lista de processos ────────────────────────────────────────────────────
// Rank de risco para ordenação (menor = mais grave). Não-analisado vai pro fim.
const RISK_RANK: Record<AuditSeverity, number> = { critico: 0, alto: 1, medio: 2, baixo: 3, ok: 3 };
type SortKey = "risco" | "parado" | "numero";
type RiskFilter = AuditSeverity | "nao" | null;

/** Classifica um item em um "bucket" de risco para stats e filtro. */
function riskBucket(item: PortfolioItem): AuditSeverity | "nao" {
  if (!item.audit) return "nao";
  return item.audit.riskLevel;
}

function ProcessListScreen({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (id: string) => void;
}) {
  const { items, collectedAt, loading, notOnPage, collect } = usePortfolio();
  const { queue, start: startQueue, stop: stopQueue, dismiss: dismissQueue } = useQueue();
  const movedIds = useMovedIds();
  const [sortKey, setSortKey] = useState<SortKey>("numero");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queueError, setQueueError] = useState<string | null>(null);

  useEffect(() => { collect(); }, []);

  const queueRunning = queue?.status === "running";

  // Contadores por bucket de risco
  const stats = useMemo(() => {
    const s = { critico: 0, alto: 0, medio: 0, conforme: 0, nao: 0 };
    for (const it of items) {
      const b = riskBucket(it);
      if (b === "nao") s.nao++;
      else if (b === "critico") s.critico++;
      else if (b === "alto") s.alto++;
      else if (b === "medio") s.medio++;
      else s.conforme++; // baixo/ok
    }
    return s;
  }, [items]);

  // Filtra + ordena
  const visible = useMemo(() => {
    let list = items;

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((p) =>
        p.id.toLowerCase().includes(q) ||
        (p.type ?? "").toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    }

    if (riskFilter) {
      list = list.filter((p) => {
        const b = riskBucket(p);
        if (riskFilter === "nao") return b === "nao";
        if (riskFilter === "baixo") return b === "baixo" || b === "ok";
        return b === riskFilter;
      });
    }

    const sorted = [...list];
    if (sortKey === "risco") {
      sorted.sort((a, b) => {
        const ra = a.audit ? RISK_RANK[a.audit.riskLevel] : 5;
        const rb = b.audit ? RISK_RANK[b.audit.riskLevel] : 5;
        if (ra !== rb) return ra - rb;
        return (b.statusInfo?.diasParado ?? -1) - (a.statusInfo?.diasParado ?? -1);
      });
    } else if (sortKey === "parado") {
      sorted.sort((a, b) => (b.statusInfo?.diasParado ?? -1) - (a.statusInfo?.diasParado ?? -1));
    }
    // "numero" mantém a ordem original da coleta
    return sorted;
  }, [items, query, riskFilter, sortKey]);

  const timeAgo = collectedAt ? atras(collectedAt) : null;

  function toggleFilter(f: RiskFilter) {
    setRiskFilter((cur) => (cur === f ? null : f));
  }

  function toggleSel(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function cancelSelecting() {
    setSelecting(false);
    setSelected(new Set());
    setQueueError(null);
  }

  async function gerarDados() {
    if (selected.size === 0) return;
    // Mantém a ordem visível na fila
    const ids = visible.filter((p) => selected.has(p.id)).map((p) => p.id);
    const ok = await startQueue(ids);
    if (!ok) {
      setQueueError("Abra o SEI na aba ativa para começar a leitura.");
      return;
    }
    cancelSelecting();
  }

  return (
    <div className="screen screen--active">
      <ScreenHeader title="Meus processos" sub={items.length ? `${items.length} na unidade` : null} onBack={onBack}>
        {items.length > 0 && !queueRunning && (
          <button className={`btn-refresh btn-refresh--txt ${selecting ? "is-on" : ""}`}
            title={selecting ? "Cancelar seleção" : "Escolher vários processos para ler de uma vez"}
            onClick={() => (selecting ? cancelSelecting() : setSelecting(true))}>
            {selecting ? <><Icon n="fechar" s={14} /> Cancelar</> : <><Icon n="selecionar" s={14} /> Ler vários</>}
          </button>
        )}
        <button className="btn-refresh" onClick={collect} disabled={loading} aria-label="Atualizar lista"
          title="Atualizar a lista (abra o Controle de Processos no SEI)">
          {loading ? <span className="collect-spinner collect-spinner--light" /> : <Icon n="atualizar" s={16} />}
        </button>
      </ScreenHeader>

      {/* Banner da fila em lote */}
      {queue && (
        <QueueBanner queue={queue} onStop={stopQueue} onDismiss={dismissQueue} />
      )}

      {notOnPage && (
        <div className="processes-hint">
          <Icon n="alerta" s={14} /> <span>Para atualizar a lista, abra o <strong>Controle de Processos</strong> no SEI e clique em atualizar.</span>
        </div>
      )}

      {loading && <div className="processes-loading">Coletando processos…</div>}

      {!loading && !notOnPage && items.length === 0 && (
        <div className="processes-empty">
          <Icon n="lista" s={26} />
          <p><b>Nenhum processo ainda</b></p>
          <p>Abra o <strong>Controle de Processos</strong> no SEI — a lista é lida de lá automaticamente.</p>
        </div>
      )}

      {items.length > 0 && (
        <>
          {/* Barra de stats — chips clicáveis filtram por risco */}
          <p className="portfolio-stats-rot">Filtrar por risco {riskFilter && <button className="btn-link" onClick={() => setRiskFilter(null)}>limpar filtro</button>}</p>
          <div className="portfolio-stats" role="group" aria-label="Filtrar por risco">
            <StatChip label="Crítico" count={stats.critico} cls="risk--critico"
              active={riskFilter === "critico"} onClick={() => toggleFilter("critico")} />
            <StatChip label="Alto" count={stats.alto} cls="risk--alto"
              active={riskFilter === "alto"} onClick={() => toggleFilter("alto")} />
            <StatChip label="Médio" count={stats.medio} cls="risk--medio"
              active={riskFilter === "medio"} onClick={() => toggleFilter("medio")} />
            <StatChip label="Conforme" count={stats.conforme} cls="risk--baixo"
              active={riskFilter === "baixo"} onClick={() => toggleFilter("baixo")} />
            <StatChip label="A analisar" count={stats.nao} cls="risk--nao"
              active={riskFilter === "nao"} onClick={() => toggleFilter("nao")} />
          </div>

          {/* Controles: busca + ordenação */}
          <div className="portfolio-controls">
            <input
              className="portfolio-search"
              placeholder="Buscar por número, tipo ou objeto" aria-label="Buscar processo"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="portfolio-sort" aria-label="Ordenar" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="numero">Ordem do SEI</option>
              <option value="risco">Maior risco</option>
              <option value="parado">Mais parados</option>
            </select>
          </div>

          {/* Barra de seleção em lote */}
          {selecting && (
            <div className="select-bar">
              <div className="select-bar-actions">
                <button className="select-link" onClick={() => setSelected(new Set(visible.map((p) => p.id)))}>
                  Todos ({visible.length})
                </button>
                <button className="select-link" onClick={() => setSelected(new Set())}>Limpar</button>
              </div>
              <button
                className="btn-gerar"
                disabled={selected.size === 0 || queueRunning}
                onClick={gerarDados}
              >
                Ler {selected.size} processo{selected.size === 1 ? "" : "s"}
              </button>
            </div>
          )}
          {queueError && <div className="summary-error summary-error--inline" style={{ margin: "0 12px 8px" }}><p>{queueError}</p></div>}

          {timeAgo && !selecting && <p className="processes-meta">Lista atualizada {timeAgo} · mostrando {visible.length} de {items.length}</p>}

          <div className="process-list">
            {visible.map((p) => (
              <PortfolioCard
                key={p.id}
                item={p}
                selecting={selecting}
                selected={selected.has(p.id)}
                isQueueCurrent={queue?.current === p.id}
                hasMoved={movedIds.has(p.id)}
                onClick={() => (selecting ? toggleSel(p.id) : onSelect(p.id))}
              />
            ))}
            {visible.length === 0 && (
              <div className="processes-empty">Nenhum processo neste filtro.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function QueueBanner({ queue, onStop, onDismiss }: {
  queue: CollectionQueueState; onStop: () => void; onDismiss: () => void;
}) {
  const processed = queue.done.length + queue.failed.length;
  const pct = queue.total > 0 ? Math.round((processed / queue.total) * 100) : 0;

  if (queue.status === "done") {
    return (
      <div className="queue-banner queue-banner--done">
        <div className="queue-banner-row">
          <span><Icon n="ok" s={14} /> Pronto — {queue.done.length} processo(s) lido(s){queue.failed.length > 0 ? `, ${queue.failed.length} falha(s)` : ""}</span>
          <button className="queue-dismiss" onClick={onDismiss}>Fechar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="queue-banner queue-banner--running">
      <div className="queue-banner-row">
        <span className="queue-banner-title">
          <span className="collect-spinner" /> Lendo processos — {processed + 1} de {queue.total}
        </span>
        <button className="queue-stop" onClick={onStop}>Parar</button>
      </div>
      {queue.current && <div className="queue-current">{queue.current}</div>}
      <div className="collect-progress-track">
        <div className="collect-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatChip({ label, count, cls, active, onClick }: {
  label: string; count: number; cls: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`stat-chip ${cls} ${active ? "stat-chip--active" : ""} ${count === 0 ? "stat-chip--empty" : ""}`}
      aria-pressed={active}
      onClick={onClick}
      disabled={count === 0}
    >
      <span className="stat-chip-count">{count}</span>
      <span className="stat-chip-label">{label}</span>
    </button>
  );
}

function PortfolioCard({ item, onClick, selecting = false, selected = false, isQueueCurrent = false, hasMoved = false }: {
  item: PortfolioItem;
  onClick: () => void;
  selecting?: boolean;
  selected?: boolean;
  isQueueCurrent?: boolean;
  hasMoved?: boolean;
}) {
  const bucket = riskBucket(item);
  const riskCls = bucket === "nao" ? "risk--nao"
    : bucket === "ok" ? "risk--baixo"
    : `risk--${bucket}`;
  const riskLabel = bucket === "nao" ? "A analisar" : RISK_META[bucket].label;
  const dias = item.statusInfo?.diasParado ?? null;
  const parado = dias !== null && !item.statusInfo?.concluido && dias > 0;
  const alertaParado = parado && dias > 30;

  return (
    <button
      className={`process-item process-item--clickable ${selected ? "process-item--selected" : ""} ${isQueueCurrent ? "process-item--current" : ""}`}
      onClick={onClick}
    >
      <div className="process-item-top">
        {selecting && (
          <span className={`process-check ${selected ? "process-check--on" : ""}`}>
            {selected ? "✓" : ""}
          </span>
        )}
        <span className="process-id">{item.id}</span>
        {hasMoved && <span className="process-moved-tag" title="Movimentou desde a última leitura"><Icon n="sino" s={13} /></span>}
        {isQueueCurrent && <span className="process-queue-tag">lendo…</span>}
        <span className={`process-risk-badge ${riskCls}`}>
          {item.audit ? `${riskLabel} · ${item.audit.score}` : riskLabel}
        </span>
      </div>
      {item.type && <div className="process-type">{item.type}</div>}
      {item.description && (
        <div className="process-desc" title={item.description}>
          {item.description.length > 60 ? item.description.slice(0, 60) + "…" : item.description}
        </div>
      )}
      <div className="process-meta-row">
        {item.statusInfo && (
          <span className="process-status-tag">{item.statusInfo.statusLabel}</span>
        )}
        {parado && (
          <span className={`process-parado ${alertaParado ? "process-parado--alert" : ""}`}>
            <Icon n="relogio" s={12} /> {dias} dia{dias === 1 ? "" : "s"} parado
          </span>
        )}
        {!item.collected && item.lastUpdate && (
          <span className="process-date">{item.lastUpdate}</span>
        )}
        <span className="process-detail-hint"><Icon n="seguir" s={15} /></span>
      </div>
    </button>
  );
}

// ── Tela: Principal ─────────────────────────────────────────────────────────────
/** Processo aberto agora na aba do SEI (gravado pelo content script). */
function useProcessoAberto() {
  const [id, setId] = useState<string | null>(null);
  const [info, setInfo] = useState<ProcessDetails | null>(null);
  useEffect(() => {
    chrome.storage.local.get("processoAberto", (r) => setId((r.processoAberto as string) ?? null));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => { if ("processoAberto" in c) setId((c.processoAberto.newValue as string) ?? null); };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  useEffect(() => {
    if (!id) { setInfo(null); return; }
    chrome.storage.local.get(`proc_${id}`, (r) => setInfo((r[`proc_${id}`] as ProcessDetails) ?? null));
  }, [id]);
  return { id, info };
}

function ActiveScreen({ session }: { session: SessionInfo }) {
  const [view, setView] = useState<View>("main");
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null);
  const [detailFrom, setDetailFrom] = useState<View>("processes");
  const [showTut, setShowTut] = useState(false);
  const [modoDev, setModoDev] = useState(false);
  const { config, pronto: cfgPronto } = useAiConfig();
  const aberto = useProcessoAberto();
  useEffect(() => {
    chrome.storage.local.get("modoDev", (r) => setModoDev(!!r.modoDev));
    const ouvir = (ch: Record<string, chrome.storage.StorageChange>) => { if (ch.modoDev) setModoDev(!!ch.modoDev.newValue); };
    chrome.storage.onChanged.addListener(ouvir);
    return () => chrome.storage.onChanged.removeListener(ouvir);
  }, []);

  // Tutorial automático na primeira abertura
  useEffect(() => {
    chrome.storage.local.get("sidebarTutorialSeen", (r) => { if (!r.sidebarTutorialSeen) setShowTut(true); });
  }, []);
  function closeTut() {
    setShowTut(false);
    chrome.storage.local.set({ sidebarTutorialSeen: true });
  }
  function abrirProcesso(id: string, de: View) { setSelectedProcess(id); setDetailFrom(de); setView("processDetail"); }

  if (view === "settings") return <SettingsScreen onBack={() => setView("main")} onControlador={() => setView("controlador")} />;
  if (view === "controlador") return <ControladorScreen onBack={() => setView("settings")} />;

  if (view === "processDetail" && selectedProcess) {
    return (
      <ProcessDetailScreen
        processId={selectedProcess}
        onBack={() => setView(detailFrom)}
        onSettings={() => setView("settings")}
      />
    );
  }

  if (view === "processes") {
    return (
      <ProcessListScreen
        onBack={() => setView("main")}
        onSelect={(id) => abrirProcesso(id, "processes")}
      />
    );
  }

  const semChave = cfgPronto && !config?.apiKey;
  const u = session.username?.trim() ?? "";
  const primeiroNome = /\s/.test(u) ? u.split(/\s+/)[0].toLowerCase().replace(/^./, (c) => c.toUpperCase()) : null; // login sem espaço não vira saudação

  return (
    <div className="screen screen--active home">
      <header className="sidebar-header">
        <div className="sidebar-logo" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L13 4V10L7 13L1 10V4L7 1Z" stroke="white" strokeWidth="1.5"/>
            <path d="M4.5 7.2l1.7 1.6L9.6 5.4" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="sidebar-header-text">
          <p className="sidebar-title">SEI Assistant</p>
          <p className="sidebar-subtitle"><span className="status-dot" /> {session.unit ?? "Conectado ao SEI"}</p>
        </div>
        <button className="btn-gear" onClick={() => setShowTut(true)} aria-label="Como usar" title="Como usar"><Icon n="ajuda" s={18} /></button>
        <button className="btn-gear" onClick={() => setView("settings")} aria-label="Configurações" title="Configurações"><Icon n="config" s={18} /></button>
      </header>

      {showTut && <SidebarTutorial onClose={closeTut} />}

      <div className="home-body">
        <p className="home-hello">{primeiroNome ? `Olá, ${primeiroNome}.` : "Olá."} O que vamos analisar?</p>

        {semChave && (
          <button className="aviso aviso--warn aviso--acao" onClick={() => setView("settings")}>
            <Icon n="chave" /> <span><b>Falta a chave da IA.</b> Sem ela, resumo, auditoria e revisão não funcionam. Configurar agora</span> <Icon n="seguir" />
          </button>
        )}

        {aberto.id ? (
          <section className="aberto">
            <p className="aberto-rot">Aberto no SEI agora</p>
            <p className="aberto-id">{aberto.id}</p>
            {aberto.info?.type && <p className="aberto-tipo">{aberto.info.type}</p>}
            {aberto.info?.description && <p className="aberto-desc">{aberto.info.description}</p>}
            <button className="btn btn--primary btn--block" onClick={() => abrirProcesso(aberto.id!, "main")}>
              Analisar este processo <Icon n="seguir" s={14} />
            </button>
            <p className="aberto-dica">Resumo, tramitação, auditoria, perguntas e revisão dos documentos.</p>
          </section>
        ) : (
          <section className="aberto aberto--vazio">
            <Icon n="doc" s={22} />
            <p><b>Abra um processo no SEI</b> e ele aparece aqui, pronto para analisar. Ou escolha na sua lista abaixo.</p>
          </section>
        )}

        <nav className="actions" aria-label="Menu">
          <ActionItem icon="lista" title="Meus processos" desc="Todos da unidade, com risco e tempo parado" onClick={() => setView("processes")}/>
          <ActionItem icon="painel" title="Painel da unidade" desc="Gráficos de prazos e gargalos" external onClick={() => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" })}/>
          {modoDev && <ActionItem icon="grafico" title="Estatísticas dos agentes" desc="Precisão, evolução e custo (modo desenvolvedor)" external onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("dist/estatisticas.html") })}/>}
        </nav>
      </div>

      <footer className="sidebar-footer">
        <span>{session.username ?? "Sessão ativa"}</span>
        <button className="btn-link" onClick={() => setShowTut(true)}>Como usar?</button>
      </footer>
    </div>
  );
}

// ── Tutorial de boas-vindas da sidebar ───────────────────────────────────────────
const SIDEBAR_TUT_STEPS: { icon: NomeIcone; title: string; body: string }[] = [
  {
    icon: "doc",
    title: "Bem-vindo ao SEI Assistant",
    body: "Ele lê os processos do SEI por você: resume, mostra a tramitação, audita a conformidade e revisa os documentos. São 4 passos rápidos.",
  },
  {
    icon: "play",
    title: "1. Abra o processo e leia",
    body: "Abra um processo no SEI e clique em “Analisar este processo” aqui na lateral. Depois, “Ler o processo”: a extensão abre a árvore e lê despachos e andamento sozinha.",
  },
  {
    icon: "resumo",
    title: "2. Resumo, tramitação e auditoria",
    body: "As abas mostram o resumo (objeto, valor, vigência…), por onde o processo passou e quanto tempo ficou em cada unidade, e uma nota de conformidade com o que falta.",
  },
  {
    icon: "revisar",
    title: "3. Revise os documentos",
    body: "Na aba “Revisar”, escolha os documentos (Termo de Referência, Edital, Minuta…). A IA aponta erros de português, conformidade e inconsistências e abre uma lista de correções.",
  },
  {
    icon: "ok",
    title: "4. Avalie as correções",
    body: "Em cada correção, marque “Já alterei” ou “Não é válida” (e diga o porquê). É assim que a revisão aprende e erra menos da próxima vez.",
  },
];

function SidebarTutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const last = step >= SIDEBAR_TUT_STEPS.length - 1;
  const s = SIDEBAR_TUT_STEPS[step];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !last) setStep((x) => x + 1);
      else if (e.key === "ArrowLeft" && step > 0) setStep((x) => x - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, last, onClose]);

  return (
    <div className="stut-overlay" role="dialog" aria-modal="true" aria-labelledby="stut-title">
      <div className="stut-card">
        <button className="stut-close" onClick={onClose} aria-label="Fechar"><Icon n="fechar" s={14} /></button>
        <div className="stut-icon"><Icon n={s.icon} s={26} /></div>
        <p className="stut-title" id="stut-title">{s.title}</p>
        <p className="stut-body">{s.body}</p>
        <div className="stut-dots">
          {SIDEBAR_TUT_STEPS.map((_, i) => (
            <button key={i} className={`stut-dot ${i === step ? "stut-dot--on" : ""}`} onClick={() => setStep(i)} aria-label={`Passo ${i + 1}`} />
          ))}
        </div>
        <div className="stut-nav">
          <button className="btn btn--ghost" onClick={() => setStep((x) => x - 1)} disabled={step === 0}>Voltar</button>
          {last ? (
            <button className="btn btn--primary" onClick={onClose}>Começar</button>
          ) : (
            <button className="btn btn--primary" onClick={() => setStep((x) => x + 1)}>Próximo</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionItem({ icon, title, desc, onClick, external }: { icon: NomeIcone; title: string; desc: string; onClick: () => void; external?: boolean }) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="action-icon"><Icon n={icon} s={18} /></span>
      <span className="action-text">
        <span className="action-title">{title}</span>
        <span className="action-desc">{desc}</span>
      </span>
      <span className="action-arrow">{external ? <Icon n="externo" s={14} /> : <Icon n="seguir" s={16} />}</span>
    </button>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────────
export default function App() {
  const session = useSession();
  return (
    <main className="app">
      {session.status === "idle" || session.status === "expired"
        ? <IdleScreen />
        : <ActiveScreen session={session} />}
    </main>
  );
}
