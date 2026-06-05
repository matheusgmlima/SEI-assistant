import { StrictMode, useEffect, useMemo, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { ProcessDetails } from "@shared/index";
import {
  mapProcessToSad, rowsToTsv, sadHeaderTsv, SAD_COLUMNS, SAD_FIELD_META, SAD_REQUIRED,
  type SadOverrides, type SadRow,
} from "@shared/index";
import { seedTestData, clearTestData } from "../dev/seed";
import "./sad.css";

interface Item {
  id: string;
  details: ProcessDetails;
  overrides: SadOverrides;
  row: SadRow;
}

const REQUIRED = new Set(SAD_REQUIRED);

function useItems() {
  const [procs, setProcs] = useState<ProcessDetails[]>([]);
  const [overrides, setOverrides] = useState<Record<string, SadOverrides>>({});
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

  const reload = useCallback(() => {
    chrome.storage.local.get(null, (all) => {
      const ps: ProcessDetails[] = [];
      const ov: Record<string, SadOverrides> = {};
      for (const k of Object.keys(all)) {
        if (k.startsWith("proc_")) ps.push(all[k] as ProcessDetails);
        else if (k.startsWith("sadOverrides_")) ov[k.slice("sadOverrides_".length)] = all[k] as SadOverrides;
      }
      ps.sort((a, b) => a.id.localeCompare(b.id));
      setProcs(ps); setOverrides(ov); setLoaded(true); setRefreshedAt(Date.now());
    });
  }, []);

  useEffect(() => {
    reload();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("proc_") || k.startsWith("sadOverrides_"))) reload();
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [reload]);

  function setField(id: string, key: string, value: string) {
    setOverrides((prev) => {
      const cur = { ...(prev[id] ?? {}), [key]: value };
      chrome.storage.local.set({ [`sadOverrides_${id}`]: cur });
      return { ...prev, [id]: cur };
    });
  }

  return { procs, overrides, loaded, setField, reload, refreshedAt };
}

function ControleSad() {
  const { procs, overrides, loaded, setField, reload, refreshedAt } = useItems();
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloaded, setReloaded] = useState(false);

  function doReload() {
    reload();
    setReloaded(true);
    setTimeout(() => setReloaded(false), 1800);
  }

  const items: Item[] = useMemo(
    () => procs.map((d) => {
      const ov = overrides[d.id] ?? {};
      return { id: d.id, details: d, overrides: ov, row: mapProcessToSad(d, ov) };
    }),
    [procs, overrides]
  );

  const visible = onlyIncomplete ? items.filter((i) => i.row.missingRequired.length > 0) : items;
  const completos = items.filter((i) => i.row.missingRequired.length === 0).length;

  function copyTsv(list: Item[]) {
    navigator.clipboard.writeText(rowsToTsv(list.map((i) => i.row))).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    });
  }

  function downloadCsv(list: Item[]) {
    const toCsv = (tsv: string) => tsv.split("\n").map((line) =>
      line.split("\t").map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const csv = "﻿" + toCsv(sadHeaderTsv()) + "\r\n" + toCsv(rowsToTsv(list.map((i) => i.row)));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Controle_SAD_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="sad">
      <header className="sad-header">
        <div>
          <h1 className="sad-title">Controle SAD — Exportação</h1>
          <p className="sad-sub">
            Campos sugeridos pelo assistente · edite o que faltar · tudo fica salvo
            <span className="sad-refreshed"> · dados de {new Date(refreshedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
          </p>
        </div>
        <div className="sad-actions">
          <button className="sad-btn sad-btn-ghost" onClick={doReload} title="Reler os dados coletados (após coletar/atualizar um processo no SEI)">
            {reloaded ? "✓ Atualizado" : "🔄 Recarregar"}
          </button>
          <button className="sad-btn sad-btn-test" onClick={() => seedTestData()} title="Carrega 4 processos fictícios para testar o fluxo">🧪 Carregar exemplos</button>
          {items.length > 0 && <button className="sad-btn sad-btn-test" onClick={() => clearTestData()} title="Remove os processos de exemplo">Limpar exemplos</button>}
          <button className="sad-btn sad-btn-ghost" onClick={() => downloadCsv(visible)} disabled={visible.length === 0}>⬇ Baixar CSV</button>
          <button className="sad-btn sad-btn-primary" onClick={() => copyTsv(visible)} disabled={visible.length === 0}>
            {copied ? "✓ Copiado!" : `📋 Copiar ${visible.length} linha(s)`}
          </button>
        </div>
      </header>

      <div className="sad-howto">
        <strong>Como colar:</strong> clique em <em>Copiar</em> → na planilha, selecione a célula <b>A</b> da 1ª linha vazia da aba <b>Acompanhamento_SAD</b> → <b>Ctrl+V</b>.
        As colunas calculadas (F, AJ+) não são preenchidas — após colar, arraste as fórmulas delas.
      </div>

      {!loaded ? (
        <div className="sad-empty">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="sad-empty">
          <p className="sad-empty-title">Nenhum processo coletado</p>
          <p>Colete processos no SEI Assistant e eles aparecem aqui prontos para exportar.</p>
          <p style={{ marginTop: 16 }}>
            <button className="sad-btn sad-btn-primary" onClick={() => seedTestData()}>🧪 Carregar 4 processos de exemplo</button>
          </p>
          <p style={{ fontSize: 11, marginTop: 8, color: "#999" }}>Dados fictícios para testar o fluxo sem precisar coletar do SEI.</p>
        </div>
      ) : (
        <>
          <div className="sad-toolbar">
            <span className="sad-count">{completos}/{items.length} com campos obrigatórios completos</span>
            <label className="sad-filter">
              <input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} />
              Só os incompletos
            </label>
          </div>
          <div className="sad-list">
            {visible.map((it) => (
              <SadCard key={it.id} item={it} onField={(k, v) => setField(it.id, k, v)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Campos inferidos propensos a erro de extração — sempre vale conferir
const REVIEW_KEYS = new Set([
  "unidadeDemandante", "evento", "modalidade", "contratada",
  "valorEstimado", "dataVigencia", "dataRecebSad", "statusAtual",
]);

type Attention = "req" | "review" | null;

function Field({ col, val, src, attention, onChange }: {
  col: typeof SAD_COLUMNS[number]; val: string; src: string; attention: Attention;
  onChange: (v: string) => void;
}) {
  const meta = SAD_FIELD_META[col.key] ?? { type: "text" as const };
  const isProc = col.key === "processoSei";
  const req = REQUIRED.has(col.key);

  return (
    <div className={`sad-field ${attention === "req" ? "sad-field--req" : attention === "review" ? "sad-field--review" : ""}`}>
      <label>
        <span className="sad-field-name">{req && <span className="req">★</span>}{col.letter} · {col.header}</span>
        {attention === "req" && <span className="tag tag-req">preencher</span>}
        {attention === "review" && <span className="tag tag-review">confira</span>}
        {!attention && <span className={`src-tag src-${src}`} />}
      </label>
      {isProc ? (
        <input value={val} readOnly className="ro" />
      ) : meta.type === "select" ? (
        <select value={val} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {val && !meta.list!.includes(val) && <option value={val}>{val} (sugerido)</option>}
          {meta.list!.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : meta.type === "area" ? (
        <textarea rows={2} value={val} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={val} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function SadCard({ item, onField }: { item: Item; onField: (key: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { row, details } = item;
  const editable = SAD_COLUMNS.filter((c) => !c.calc);

  const attentionOf = (key: string): Attention => {
    const val = row.values[key] ?? "";
    if (REQUIRED.has(key) && !val) return "req";
    if (REVIEW_KEYS.has(key) && row.sources[key] === "inferido" && val) return "review";
    return null;
  };

  const attentionCols = editable.filter((c) => attentionOf(c.key));
  const restCols = editable.filter((c) => !attentionOf(c.key));
  const nReq = attentionCols.filter((c) => attentionOf(c.key) === "req").length;
  const nReview = attentionCols.filter((c) => attentionOf(c.key) === "review").length;
  const complete = nReq === 0;

  return (
    <div className={`sad-card ${complete ? "" : "sad-card--incomplete"}`}>
      <div className="sad-card-head" onClick={() => setOpen((o) => !o)}>
        <span className="sad-card-id">{details.id}</span>
        <span className="sad-card-obj">{row.values.objeto || "(sem objeto)"}</span>
        <span className="sad-head-badges">
          {nReq > 0 && <span className="sad-badge sad-badge--req">{nReq} preencher</span>}
          {nReview > 0 && <span className="sad-badge sad-badge--review">{nReview} conferir</span>}
          {complete && nReview === 0 && <span className="sad-badge sad-badge--ok">✓ Completo</span>}
        </span>
        <span className="sad-chevron">{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div className="sad-card-body">
          {/* Bloco de atenção — só o que importa */}
          {attentionCols.length > 0 ? (
            <div className="sad-attention">
              <p className="sad-block-title">
                <span className="sad-block-icon">⚠️</span> Revisar e completar
                <span className="sad-block-hint">campos obrigatórios e sugestões a conferir</span>
              </p>
              <div className="sad-grid">
                {attentionCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={attentionOf(c.key)} onChange={(v) => onField(c.key, v)} />
                ))}
              </div>
            </div>
          ) : (
            <div className="sad-allgood">✓ Nada a revisar — todos os campos-chave estão preenchidos.</div>
          )}

          {/* Demais campos — recolhidos por padrão */}
          <button className="sad-toggle-all" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "▾ Ocultar demais campos" : `▸ Ver demais campos (${restCols.length})`}
          </button>
          {showAll && (
            <div className="sad-rest">
              <p className="sad-legend">
                <span className="dot src-auto" /> coletado &nbsp;
                <span className="dot src-inferido" /> inferido &nbsp;
                <span className="dot src-manual" /> editado
              </p>
              <div className="sad-grid">
                {restCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={null} onChange={(v) => onField(c.key, v)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ControleSad /></StrictMode>
);
