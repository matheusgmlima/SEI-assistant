import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import type {
  SessionInfo, SeiProcess, ProcessDetails, AndamentoEntry,
  AuditResult, AuditFinding, AuditSeverity, ProcessStatusInfo, CollectionQueueState,
} from "@shared/index";
import { deriveStatus, extractImportantDocs, cleanDocTitle } from "@shared/index";
import type { AiConfig } from "../background/index";

// ─── Tipos de view ──────────────────────────────────────────────────────────────
type View = "main" | "processes" | "processDetail" | "settings";
type DetailTab = "resumo" | "tramitacao" | "auditoria" | "perguntar";

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

// ─── AI Presets ─────────────────────────────────────────────────────────────────
const AI_PRESETS: Record<string, { baseUrl: string; model: string; label: string }> = {
  groq:   { baseUrl: "https://api.groq.com/openai/v1",  model: "llama-3.3-70b-versatile", label: "Groq (gratuito)" },
  openai: { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini",              label: "OpenAI" },
  custom: { baseUrl: "",                                 model: "",                         label: "Custom" },
};

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

  useEffect(() => {
    chrome.storage.local.get("aiConfig", (r) => { if (r.aiConfig) setConfig(r.aiConfig); });
  }, []);

  function save(cfg: AiConfig) {
    chrome.storage.local.set({ aiConfig: cfg });
    setConfig(cfg);
  }

  return { config, save };
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
      <p className="idle-title">Aguardando login</p>
      <p className="idle-desc">Faça login no SEI para ativar o assistente.</p>
      <p className="idle-hint">Já está logado? Recarregue a página do SEI.</p>
    </div>
  );
}

// ── Tela: Configurações ─────────────────────────────────────────────────────────
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { config, save } = useAiConfig();
  const [provider, setProvider] = useState<string>(config?.provider ?? "groq");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [model, setModel] = useState(config?.model ?? AI_PRESETS.groq.model);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? AI_PRESETS.groq.baseUrl);
  const [saved, setSaved] = useState(false);

  function handleProviderChange(p: string) {
    setProvider(p);
    if (p !== "custom") {
      setModel(AI_PRESETS[p].model);
      setBaseUrl(AI_PRESETS[p].baseUrl);
    }
  }

  function handleSave() {
    save({ provider: provider as AiConfig["provider"], apiKey, model, baseUrl });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="screen screen--active">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title">Configurações IA</span>
      </header>

      <div className="settings-body">
        <label className="settings-label">Provider</label>
        <select className="settings-select" value={provider} onChange={(e) => handleProviderChange(e.target.value)}>
          {Object.entries(AI_PRESETS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <label className="settings-label">API Key</label>
        <input
          className="settings-input"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />

        <label className="settings-label">Modelo</label>
        <input
          className="settings-input"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        {provider === "custom" && (
          <>
            <label className="settings-label">Base URL</label>
            <input
              className="settings-input"
              placeholder="https://..."
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </>
        )}

        <button className="btn-save" onClick={handleSave} disabled={!apiKey}>
          {saved ? "✓ Salvo!" : "Salvar"}
        </button>

        <p className="settings-hint">
          Groq é gratuito — crie sua chave em <strong>console.groq.com</strong>
        </p>
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
}: {
  progress: CollectionProgress | null;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  hasData: boolean;
}) {
  if (!progress || progress.status === "done") {
    return (
      <div className="collect-bar">
        {progress?.status === "done" && (
          <div className="collect-done">✓ Dados coletados com sucesso!</div>
        )}
        <button className="btn-collect" onClick={onStart}>
          {hasData ? "↺ Atualizar dados do processo" : "⚡ Coletar dados do processo"}
        </button>
        {progress?.status === "done" && (
          <button className="btn-collect-reset" onClick={onReset}>Limpar</button>
        )}
      </div>
    );
  }

  if (progress.status === "error") {
    return (
      <div className="collect-bar">
        <div className="collect-error">✗ {progress.phase}</div>
        <button className="btn-collect" onClick={onStart}>Tentar novamente</button>
        <button className="btn-collect-reset" onClick={onReset}>Limpar</button>
      </div>
    );
  }

  // Running
  const pct = Math.round((progress.step / progress.totalSteps) * 100);
  const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);

  return (
    <div className="collect-bar collect-bar--running">
      <div className="collect-phase">
        <span className="collect-spinner" />
        <span>{progress.phase}</span>
      </div>
      <div className="collect-progress-track">
        <div className="collect-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="collect-meta">
        <span>Passo {progress.step}/{progress.totalSteps}</span>
        <span>{elapsed}s</span>
      </div>
      <button className="btn-collect-stop" onClick={onStop} title="Cancelar coleta">
        ✕ Parar coleta
      </button>
    </div>
  );
}

// ── Componente: Árvore de Tramitação ────────────────────────────────────────────
function TramitacaoTimeline({ details }: { details: ProcessDetails }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const phases = buildTramitacao(details);
  const hasAndamento = details.andamento.length > 0;

  if (phases.length === 0) {
    return (
      <div className="tram-empty">
        <p>Nenhum despacho com unidade identificada.</p>
        <p className="tram-hint">
          Para ver datas completas, clique em <strong>Consultar Andamento</strong> no SEI.
        </p>
      </div>
    );
  }

  const totalDays = phases.reduce((acc, p) => acc + (p.durationDays ?? 0), 0);

  return (
    <div className="tram-tree">
      {!hasAndamento && (
        <div className="tram-notice">
          Sem datas — abra o processo no SEI e clique em <strong>Consultar Andamento</strong>. O assistente extrai automaticamente.
        </div>
      )}

      {phases.map((phase, i) => {
        const isOpen = expanded[i];
        const pct = totalDays > 0 && phase.durationDays !== null
          ? Math.round((phase.durationDays / totalDays) * 100)
          : null;

        return (
          <div key={i} className={`tram-node ${phase.isCurrent ? "tram-node--current" : ""}`}>
            {/* Linha vertical conectora */}
            <div className="tram-spine">
              <div className={`tram-bullet ${phase.isCurrent ? "tram-bullet--active" : ""}`} />
              {i < phases.length - 1 && <div className="tram-spine-line" />}
            </div>

            <div className="tram-body">
              {/* Cabeçalho da unidade */}
              <div className="tram-header" onClick={() => setExpanded((p) => ({ ...p, [i]: !isOpen }))}>
                <span className="tram-unit-name">{phase.unit}</span>
                <div className="tram-header-right">
                  {phase.concluded && (
                    <span className="tram-badge tram-badge--concluded">✓ Concluído</span>
                  )}
                  {!phase.concluded && phase.durationDays !== null && (
                    <span className={`tram-badge ${phase.isCurrent ? "tram-badge--active" : ""}`}>
                      {phase.isCurrent ? `${phase.durationDays}d ●` : `${phase.durationDays}d`}
                    </span>
                  )}
                  {phase.despachos.length > 0 && (
                    <span className="tram-chevron">{isOpen ? "▾" : "▸"}</span>
                  )}
                </div>
              </div>

              {/* Datas */}
              {(phase.enteredAt || phase.leftAt) && (
                <div className="tram-dates">
                  {phase.enteredAt && <span>↓ {fmtDate(phase.enteredAt)}</span>}
                  {phase.leftAt    && <span>↑ {fmtDate(phase.leftAt)}</span>}
                  {pct !== null    && <span className="tram-pct">{pct}% do tempo</span>}
                </div>
              )}

              {/* Barra de proporção (quando há andamento) */}
              {hasAndamento && pct !== null && (
                <div className="tram-bar-track">
                  <div
                    className={`tram-bar-fill ${phase.isCurrent ? "tram-bar-fill--active" : ""}`}
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
                </div>
              )}

              {/* Lista de despachos — sempre visível se houver */}
              {phase.despachos.length > 0 && (
                <ul className="tram-despachos">
                  {phase.despachos.map((d, j) => (
                    <li key={j} className="tram-despacho-item">
                      <span className="tram-despacho-id">#{d.docId ?? "—"}</span>
                      <span className="tram-despacho-title">
                        {d.title.replace(/despacho\s+\d+\s*/i, "").trim() || d.title}
                      </span>
                      {d.date && <span className="tram-despacho-date">{fmtDate(d.date)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}

      {hasAndamento && totalDays > 0 && (
        <div className="tram-total">Total: {totalDays} dias no processo</div>
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
      <div className="audit-loading">
        <span className="collect-spinner" />
        <span>Analisando conformidade do processo…</span>
      </div>
    );
  }

  if (!audit) {
    return (
      <div className="audit-empty">
        <p className="audit-empty-title">Auditoria de conformidade</p>
        <p className="audit-empty-desc">
          Verifica documentos obrigatórios, prazos, sequência dos atos e aponta riscos com recomendações.
        </p>
        {!hasData && (
          <p className="audit-empty-hint">Colete os dados do processo primeiro para uma análise completa.</p>
        )}
        {!hasApiKey && (
          <p className="audit-empty-hint">Sem chave de IA: a auditoria roda só com as verificações automáticas (checklist + regras).</p>
        )}
        {error && <div className="summary-error summary-error--inline"><p>{error}</p></div>}
        <button className="btn-summarize" onClick={onRun}>🛡️ Auditar processo</button>
      </div>
    );
  }

  const risk = RISK_META[audit.riskLevel];
  const presentes = audit.checklist.filter((c) => c.status === "presente").length;
  const totalCheck = audit.checklist.length;

  // Agrupa findings por severidade na ordem de gravidade
  const order: AuditSeverity[] = ["critico", "alto", "medio", "baixo"];
  const sortedFindings = [...audit.findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)
  );

  const genAt = new Date(audit.generatedAt);
  const genStr = `${String(genAt.getDate()).padStart(2, "0")}/${String(genAt.getMonth() + 1).padStart(2, "0")} ${String(genAt.getHours()).padStart(2, "0")}:${String(genAt.getMinutes()).padStart(2, "0")}`;

  return (
    <div className="audit-panel">
      {/* Cabeçalho: score + risco */}
      <div className={`audit-scorecard ${risk.cls}`}>
        <div className="audit-score-ring">
          <span className="audit-score-num">{audit.score}</span>
          <span className="audit-score-max">/100</span>
        </div>
        <div className="audit-score-info">
          <span className={`audit-risk-badge ${risk.cls}`}>{risk.label}</span>
          <span className="audit-score-label">Conformidade</span>
          <span className="audit-findings-count">
            {audit.findings.length} {audit.findings.length === 1 ? "achado" : "achados"} · {presentes}/{totalCheck} documentos
          </span>
        </div>
      </div>

      {/* Parecer da IA */}
      {audit.aiSummary && (
        <div className="audit-summary">
          <p className="audit-section-label">Parecer</p>
          <p className="audit-summary-text">{audit.aiSummary}</p>
        </div>
      )}

      {/* Achados */}
      <div className="audit-block">
        <p className="audit-section-label">Achados ({audit.findings.length})</p>
        {sortedFindings.length === 0 ? (
          <div className="audit-no-findings">✓ Nenhuma irregularidade identificada.</div>
        ) : (
          <div className="audit-findings">
            {sortedFindings.map((f, i) => (
              <AuditFindingCard key={i} finding={f} />
            ))}
          </div>
        )}
      </div>

      {/* Checklist documental */}
      <div className="audit-block">
        <p className="audit-section-label">Checklist documental</p>
        <ul className="audit-checklist">
          {audit.checklist.map((c, i) => (
            <li key={i} className={`audit-check audit-check--${c.status}`}>
              <span className="audit-check-icon">
                {c.status === "presente" ? "✓" : c.critical ? "✗" : "○"}
              </span>
              <span className="audit-check-label">
                {c.label}
                {c.status === "ausente" && c.critical && <span className="audit-check-tag">obrigatório</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="audit-footer">
        <span>Gerado em {genStr}</span>
        <button className="btn-collect-reset" onClick={onRun}>↺ Reauditar</button>
      </div>
    </div>
  );
}

function AuditFindingCard({ finding }: { finding: AuditFinding }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY_META[finding.severity];
  return (
    <div className={`audit-finding ${meta.cls}`}>
      <button className="audit-finding-head" onClick={() => setOpen((o) => !o)}>
        <span className="audit-finding-sev">{meta.icon}</span>
        <span className="audit-finding-title">{finding.title}</span>
        <span className="audit-finding-cat">{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
        <span className="audit-finding-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="audit-finding-body">
          <p className="audit-finding-desc">{finding.description}</p>
          {finding.recommendation && (
            <p className="audit-finding-rec">
              <strong>Recomendação:</strong> {finding.recommendation}
            </p>
          )}
          <span className={`audit-finding-source audit-finding-source--${finding.source}`}>
            {finding.source === "ia" ? "🤖 IA" : "⚙ Regra automática"}
          </span>
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
        <p className="qa-empty-title">💬 Pergunte ao processo</p>
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
                : "Colete os dados do processo primeiro para respostas completas. Você ainda pode perguntar, mas a IA terá pouco contexto."}
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
          <button className="qa-clear" onClick={clear} title="Limpar conversa">🗑</button>
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
        <button className="qa-send" onClick={() => send()} disabled={loading || !input.trim()}>→</button>
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

// ── Tela: Detalhe do processo ───────────────────────────────────────────────────
function ProcessDetailScreen({
  processId,
  onBack,
  onSettings,
}: {
  processId: string;
  onBack: () => void;
  onSettings: () => void;
}) {
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

  useEffect(() => {
    if (details?.summary && summaryRef.current) {
      summaryRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [details?.summary]);

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

  const timeAgo = details?.extractedAt
    ? (() => {
        const d = Math.floor((Date.now() - details.extractedAt) / 1000);
        if (d < 60) return `${d}s atrás`;
        if (d < 3600) return `${Math.floor(d / 60)}min atrás`;
        return `${Math.floor(d / 3600)}h atrás`;
      })()
    : null;

  return (
    <div className="screen screen--active detail-screen">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title" title={processId}>{processId}</span>
        {details && (
          <button
            className="btn-refresh"
            title="Exportar dossiê (PDF / Word)"
            onClick={exportDossie}
          >
            📥
          </button>
        )}
        <button
          className="btn-refresh"
          title="Expandir todas as pastas da árvore"
          onClick={expandTree}
          disabled={expanding}
        >
          {expanding ? "⏳" : "📂"}
        </button>
      </header>

      {!details && (
        <div className="detail-waiting">
          <p className="detail-waiting-title">Aguardando dados…</p>
          <p className="detail-waiting-desc">
            Abra o processo <strong>{processId}</strong> no SEI para carregar as informações.
          </p>
        </div>
      )}

      {details && (
        <div className="detail-body">
          {timeAgo && <p className="processes-meta">Dados coletados {timeAgo}</p>}

          {/* Coleta guiada */}
          <CollectionProgressBar
            progress={collectProgress}
            onStart={startCollection}
            onStop={stopCollection}
            onReset={resetCollection}
            hasData={hasData}
          />

          {/* Abas */}
          <div className="detail-tabs">
            <button
              className={`detail-tab ${tab === "resumo" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("resumo")}
            >Resumo</button>
            <button
              className={`detail-tab ${tab === "tramitacao" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("tramitacao")}
            >Tramitação</button>
            <button
              className={`detail-tab ${tab === "auditoria" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("auditoria")}
            >
              Auditoria
              {audit && <span className={`detail-tab-dot ${RISK_META[audit.riskLevel].cls}`} />}
            </button>
            <button
              className={`detail-tab ${tab === "perguntar" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("perguntar")}
            >Perguntar</button>
          </div>

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
              <div className="tram-toolbar">
                <button
                  className="btn-summarize btn-summarize--secondary"
                  onClick={generateTramitacao}
                  disabled={generatingTram}
                >
                  {generatingTram ? "⏳ Aguardando SEI…" : "🤖 Gerar Tramitação"}
                </button>
              </div>
              {waitingForSei && (
                <div className="summary-loading summary-loading--inline">
                  <span className="tram-spinner" />
                  <span>Abra <strong>Consultar Andamento</strong> no SEI. O assistente vai extrair automaticamente.</span>
                </div>
              )}
              {tramError && !waitingForSei && (
                <div className="summary-error summary-error--inline">
                  <p>{tramError}</p>
                </div>
              )}
              <TramitacaoTimeline details={details} />
            </>
          )}

          {/* Aba: Resumo — conteúdo original */}
          {tab === "resumo" && <>

          {/* Metadados */}
          {details.type && <div className="detail-field"><span className="detail-key">Tipo</span><span className="detail-val">{details.type}</span></div>}
          {details.description && <div className="detail-field"><span className="detail-key">Especificação</span><span className="detail-val">{details.description}</span></div>}
          {details.currentUnit && <div className="detail-field"><span className="detail-key">Unidade</span><span className="detail-val">{details.currentUnit}</span></div>}
          {details.parties.length > 0 && (
            <div className="detail-field"><span className="detail-key">Interessados</span><span className="detail-val">{details.parties.join(", ")}</span></div>
          )}

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
                <p className="detail-section-title">📎 Documentos-chave ({keyDocs.length})</p>
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

          {/* Resumo IA */}
          <div className="detail-section" ref={summaryRef}>
            <p className="detail-section-title">Resumo com IA</p>

            {!hasApiKey && (
              <div className="summary-no-key">
                <p>Nenhuma API key configurada.</p>
                <button className="btn-config-link" onClick={onSettings}>
                  Configurar agora →
                </button>
              </div>
            )}

            {hasApiKey && !details.summary && !summarizing && (
              <button className="btn-summarize" onClick={generateSummary}>
                ✨ Gerar resumo
              </button>
            )}

            {summarizing && (
              <div className="summary-loading">Gerando resumo…</div>
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
                  ↺ Regenerar
                </button>
              </div>
            )}
          </div>

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
  const [sortKey, setSortKey] = useState<SortKey>("risco");
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

  const timeAgo = collectedAt
    ? (() => {
        const d = Math.floor((Date.now() - collectedAt) / 1000);
        if (d < 60) return `${d}s atrás`;
        if (d < 3600) return `${Math.floor(d / 60)}min atrás`;
        return `${Math.floor(d / 3600)}h atrás`;
      })()
    : null;

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
      setQueueError("Abra o SEI na aba ativa para iniciar a fila de coleta.");
      return;
    }
    cancelSelecting();
  }

  return (
    <div className="screen screen--active">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title">Meus Processos</span>
        {items.length > 0 && !queueRunning && (
          <button
            className="btn-refresh"
            title={selecting ? "Cancelar seleção" : "Selecionar processos para coletar em lote"}
            onClick={() => (selecting ? cancelSelecting() : setSelecting(true))}
          >
            {selecting ? "✕" : "☑"}
          </button>
        )}
        <button className="btn-refresh" onClick={collect} disabled={loading}
          title="Abra 'Controle de Processos' no SEI antes de atualizar">
          {loading ? "…" : "↻"}
        </button>
      </header>

      {/* Banner da fila em lote */}
      {queue && (
        <QueueBanner queue={queue} onStop={stopQueue} onDismiss={dismissQueue} />
      )}

      {notOnPage && (
        <div className="processes-hint">
          Abra <strong>Controle de Processos</strong> no SEI e clique em ↻
        </div>
      )}

      {loading && <div className="processes-loading">Coletando processos…</div>}

      {!loading && !notOnPage && items.length === 0 && (
        <div className="processes-empty">
          Nenhum processo encontrado.<br />
          Navegue até "Controle de Processos" no SEI.
        </div>
      )}

      {items.length > 0 && (
        <>
          {/* Barra de stats — chips clicáveis filtram por risco */}
          <div className="portfolio-stats">
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
              placeholder="Buscar nº, tipo ou objeto…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="portfolio-sort" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="risco">Risco</option>
              <option value="parado">Mais parados</option>
              <option value="numero">Ordem original</option>
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
                ⚡ Gerar dados ({selected.size})
              </button>
            </div>
          )}
          {queueError && <div className="summary-error summary-error--inline" style={{ margin: "0 12px 8px" }}><p>{queueError}</p></div>}

          {timeAgo && !selecting && <p className="processes-meta">Atualizado {timeAgo} · {visible.length} de {items.length}</p>}

          <div className="process-list">
            {visible.map((p) => (
              <PortfolioCard
                key={p.id}
                item={p}
                selecting={selecting}
                selected={selected.has(p.id)}
                isQueueCurrent={queue?.current === p.id}
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
          <span>✓ Fila concluída — {queue.done.length} coletado(s){queue.failed.length > 0 ? `, ${queue.failed.length} falha(s)` : ""}</span>
          <button className="queue-dismiss" onClick={onDismiss}>Fechar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="queue-banner queue-banner--running">
      <div className="queue-banner-row">
        <span className="queue-banner-title">
          <span className="collect-spinner" /> Coletando em lote — {processed + 1} de {queue.total}
        </span>
        <button className="queue-stop" onClick={onStop}>Parar</button>
      </div>
      {queue.current && <div className="queue-current">Processando {queue.current}</div>}
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
      onClick={onClick}
      disabled={count === 0}
    >
      <span className="stat-chip-count">{count}</span>
      <span className="stat-chip-label">{label}</span>
    </button>
  );
}

function PortfolioCard({ item, onClick, selecting = false, selected = false, isQueueCurrent = false }: {
  item: PortfolioItem;
  onClick: () => void;
  selecting?: boolean;
  selected?: boolean;
  isQueueCurrent?: boolean;
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
        {isQueueCurrent && <span className="process-queue-tag">⏳ coletando</span>}
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
            ⏱ {dias}d parado
          </span>
        )}
        {!item.collected && item.lastUpdate && (
          <span className="process-date">🕐 {item.lastUpdate}</span>
        )}
        <span className="process-detail-hint">→</span>
      </div>
    </button>
  );
}

// ── Tela: Principal ─────────────────────────────────────────────────────────────
function ActiveScreen({ session }: { session: SessionInfo }) {
  const [view, setView] = useState<View>("main");
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null);

  if (view === "settings") return <SettingsScreen onBack={() => setView("main")} />;

  if (view === "processDetail" && selectedProcess) {
    return (
      <ProcessDetailScreen
        processId={selectedProcess}
        onBack={() => setView("processes")}
        onSettings={() => setView("settings")}
      />
    );
  }

  if (view === "processes") {
    return (
      <ProcessListScreen
        onBack={() => setView("main")}
        onSelect={(id) => { setSelectedProcess(id); setView("processDetail"); }}
      />
    );
  }

  return (
    <div className="screen screen--active">
      <header className="sidebar-header">
        <div className="sidebar-logo">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L13 4V10L7 13L1 10V4L7 1Z" stroke="white" strokeWidth="1.5"/>
          </svg>
        </div>
        <div className="sidebar-header-text">
          <p className="sidebar-title">SEI Assistant</p>
          <p className="sidebar-subtitle">TJPE</p>
        </div>
        <button className="btn-gear" onClick={() => setView("settings")} title="Configurações IA">⚙</button>
      </header>

      <div className="status-badge">
        <span className="status-dot"/>
        <span>Sessão ativa</span>
      </div>

      {(session.username || session.unit) && (
        <div className="user-info">
          {session.username && <p className="user-name">{session.username}</p>}
          {session.unit && <p className="user-unit">{session.unit}</p>}
        </div>
      )}

      <nav className="actions">
        <p className="actions-label">Ações rápidas</p>
        <ActionItem icon="📋" title="Meus processos" desc="Listar e resumir processos" onClick={() => setView("processes")}/>
        <ActionItem icon="📄" title="Resumir documento" desc="Documento aberto no SEI" onClick={() => {}}/>
        <ActionItem icon="📊" title="Gerar relatório" desc="Exportar período" onClick={() => {}}/>
      </nav>

      <footer className="sidebar-footer">
        <button className="btn-dashboard" onClick={() => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" })}>
          Abrir dashboard →
        </button>
      </footer>
    </div>
  );
}

function ActionItem({ icon, title, desc, onClick }: { icon: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="action-icon">{icon}</span>
      <span className="action-text">
        <span className="action-title">{title}</span>
        <span className="action-desc">{desc}</span>
      </span>
      <span className="action-arrow">›</span>
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
