import { StrictMode, useEffect, useMemo, useState, useCallback, useRef, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ProcessDetails } from "@shared/index";
import {
  mapProcessToSad, rowsToTsv, sadHeaderTsv, SAD_COLUMNS, SAD_FIELD_META, SAD_REQUIRED, SAD_LISTS,
  sadFieldIssue, validateSadRow,
  type SadOverrides, type SadRow, type SadDefaults,
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

/** Registro proc_* legível: objeto com id string não-vazio. Qualquer outra coisa é lixo. */
function isReadableProc(v: unknown): v is ProcessDetails {
  return !!v && typeof v === "object" && typeof (v as ProcessDetails).id === "string" && (v as ProcessDetails).id.length > 0;
}

function useItems() {
  const [procs, setProcs] = useState<ProcessDetails[]>([]);
  const [overrides, setOverrides] = useState<Record<string, SadOverrides>>({});
  const [corruptedKeys, setCorruptedKeys] = useState<string[]>([]); // chaves proc_* ilegíveis
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

  // Escrita com debounce: digitar não dispara uma gravação (e releitura geral) por tecla.
  const pendingWrites = useRef<Record<string, SadOverrides>>({});
  const writeTimers = useRef<Record<string, number>>({});

  function flushWrite(id: string) {
    const cur = pendingWrites.current[id];
    if (cur) { try { chrome.storage.local.set({ [`sadOverrides_${id}`]: cur }); } catch { /* contexto */ } }
    delete pendingWrites.current[id];
    if (writeTimers.current[id]) { clearTimeout(writeTimers.current[id]); delete writeTimers.current[id]; }
  }

  const reload = useCallback(() => {
    chrome.storage.local.get(null, (all) => {
      const ps: ProcessDetails[] = [];
      const ov: Record<string, SadOverrides> = {};
      const bad: string[] = [];
      for (const k of Object.keys(all)) {
        if (k.startsWith("proc_")) {
          if (isReadableProc(all[k])) ps.push(all[k] as ProcessDetails);
          else bad.push(k);
        } else if (k.startsWith("sadOverrides_")) {
          const v = all[k];
          if (v && typeof v === "object") ov[k.slice("sadOverrides_".length)] = v as SadOverrides;
        }
      }
      // Edições ainda não gravadas (debounce em curso) prevalecem sobre o storage
      for (const id of Object.keys(pendingWrites.current)) ov[id] = pendingWrites.current[id];
      ps.sort((a, b) => a.id.localeCompare(b.id));
      setProcs(ps); setOverrides(ov); setCorruptedKeys(bad); setLoaded(true); setRefreshedAt(Date.now());
    });
  }, []);

  useEffect(() => {
    reload();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("proc_") || k.startsWith("sadOverrides_"))) reload();
    };
    chrome.storage.onChanged.addListener(fn);
    // Garante que edição digitada nos últimos ms não se perde ao fechar a aba
    const flushAll = () => { for (const id of Object.keys(pendingWrites.current)) flushWrite(id); };
    window.addEventListener("beforeunload", flushAll);
    return () => {
      chrome.storage.onChanged.removeListener(fn);
      window.removeEventListener("beforeunload", flushAll);
      flushAll();
    };
  }, [reload]);

  function setField(id: string, key: string, value: string) {
    setOverrides((prev) => {
      const cur = { ...(prev[id] ?? {}), [key]: value };
      pendingWrites.current[id] = cur;
      if (writeTimers.current[id]) clearTimeout(writeTimers.current[id]);
      writeTimers.current[id] = window.setTimeout(() => flushWrite(id), 400);
      return { ...prev, [id]: cur };
    });
  }

  // Zera as edições manuais (overrides) de um conjunto de processos
  function clearOverrides(ids: string[]) {
    setOverrides((prev) => {
      const n = { ...prev };
      for (const id of ids) {
        delete n[id];
        delete pendingWrites.current[id]; // cancela gravação pendente que ressuscitaria a edição
        if (writeTimers.current[id]) { clearTimeout(writeTimers.current[id]); delete writeTimers.current[id]; }
        chrome.storage.local.remove(`sadOverrides_${id}`);
      }
      return n;
    });
  }

  // Remove processos da extensão (storage) por completo
  function removeProcs(ids: string[]) {
    const keys: string[] = [];
    for (const id of ids) {
      delete pendingWrites.current[id];
      if (writeTimers.current[id]) { clearTimeout(writeTimers.current[id]); delete writeTimers.current[id]; }
      keys.push(`proc_${id}`, `sadOverrides_${id}`, `qa_${id}`, `docIncorporated_${id}`,
        `historicoUrl_${id}`, `procInternalId_${id}`, `sadLaunched_${id}`);
    }
    chrome.storage.local.remove(keys);
    setProcs((prev) => prev.filter((p) => !ids.includes(p.id)));
    // limpa dos mapas de "lançados" e snapshots também
    chrome.storage.local.get(["sadLaunched", "sadSnapshots"], (r) => {
      const launched = (r.sadLaunched as Record<string, string>) ?? {};
      const snaps = (r.sadSnapshots as Record<string, unknown>) ?? {};
      let changed = false;
      for (const id of ids) {
        if (id in launched) { delete launched[id]; changed = true; }
        if (id in snaps) { delete snaps[id]; changed = true; }
      }
      if (changed) chrome.storage.local.set({ sadLaunched: launched, sadSnapshots: snaps });
    });
  }

  // Apaga as chaves proc_* ilegíveis detectadas no reload
  function cleanCorrupted() {
    if (corruptedKeys.length) chrome.storage.local.remove(corruptedKeys);
    setCorruptedKeys([]);
  }

  return { procs, overrides, corruptedKeys, cleanCorrupted, loaded, setField, clearOverrides, removeProcs, reload, refreshedAt };
}

// Hook: padrões pessoais (auto-preenchimento dos campos manuais)
function useDefaults() {
  const [defaults, setDefaults] = useState<SadDefaults>({});
  useEffect(() => {
    chrome.storage.local.get("sadDefaults", (r) => setDefaults((r.sadDefaults as SadDefaults) ?? {}));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.sadDefaults) setDefaults((c.sadDefaults.newValue as SadDefaults) ?? {});
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  function save(d: SadDefaults) {
    setDefaults(d);
    chrome.storage.local.set({ sadDefaults: d });
  }
  return { defaults, save };
}

// Hook: controle de "já lançado na planilha" (id → data ISO) + snapshot dos
// valores na hora do lançamento (para detectar o que mudou depois).
type SnapshotMap = Record<string, Record<string, string>>;

function useLaunched() {
  const [launched, setLaunched] = useState<Record<string, string>>({});
  const [snapshots, setSnapshots] = useState<SnapshotMap>({});
  useEffect(() => {
    chrome.storage.local.get(["sadLaunched", "sadSnapshots"], (r) => {
      setLaunched((r.sadLaunched as Record<string, string>) ?? {});
      setSnapshots((r.sadSnapshots as SnapshotMap) ?? {});
    });
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.sadLaunched) setLaunched((c.sadLaunched.newValue as Record<string, string>) ?? {});
      if (c.sadSnapshots) setSnapshots((c.sadSnapshots.newValue as SnapshotMap) ?? {});
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  function setMany(ids: string[], value: boolean, snaps?: SnapshotMap) {
    setLaunched((prev) => {
      const n = { ...prev };
      for (const id of ids) { if (value) n[id] = new Date().toISOString(); else delete n[id]; }
      chrome.storage.local.set({ sadLaunched: n });
      return n;
    });
    setSnapshots((prev) => {
      const n = { ...prev };
      for (const id of ids) {
        if (value && snaps?.[id]) n[id] = snaps[id];
        else if (!value) delete n[id];
      }
      chrome.storage.local.set({ sadSnapshots: n });
      return n;
    });
  }
  return {
    launched, snapshots, setMany,
    toggle: (id: string, v: boolean, snap?: Record<string, string>) =>
      setMany([id], v, snap ? { [id]: snap } : undefined),
  };
}

/** Valores exportáveis atuais de um item (base do snapshot de lançamento). */
function snapOf(row: SadRow): Record<string, string> {
  const s: Record<string, string> = {};
  for (const c of SAD_COLUMNS) if (!c.calc) s[c.key] = row.values[c.key] ?? "";
  return s;
}

/** O que mudou entre o snapshot do lançamento e os valores atuais. */
function diffSnapshot(row: SadRow, snap?: Record<string, string>): { key: string; header: string; from: string; to: string }[] {
  if (!snap) return [];
  const out: { key: string; header: string; from: string; to: string }[] = [];
  for (const c of SAD_COLUMNS) {
    if (c.calc) continue;
    const from = (snap[c.key] ?? "").trim();
    const to = (row.values[c.key] ?? "").trim();
    if (from !== to) out.push({ key: c.key, header: c.header, from, to });
  }
  return out;
}

/** Copia texto com fallback (clipboard API pode falhar sem foco/permissão). */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* tenta fallback */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// Chaves que entram no backup (e as ÚNICAS aceitas na restauração)
const BACKUP_PREFIXES = ["proc_", "sadOverrides_", "qa_"];
const BACKUP_KEYS = ["sadDefaults", "sadLaunched", "sadSnapshots", "seedIds"];
const isBackupKey = (k: string) => BACKUP_KEYS.includes(k) || BACKUP_PREFIXES.some((p) => k.startsWith(p));

function ControleSad() {
  const { procs, overrides, corruptedKeys, cleanCorrupted, loaded, setField, clearOverrides, removeProcs, reload, refreshedAt } = useItems();
  const { defaults, save: saveDefaults } = useDefaults();
  const { launched, snapshots, toggle: toggleLaunched, setMany: setManyLaunched } = useLaunched();
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [reloaded, setReloaded] = useState(false);
  const [picking, setPicking] = useState(false);        // tela de seleção de revisão
  const [focusIds, setFocusIds] = useState<string[] | null>(null); // ids no modo foco
  const [showTut, setShowTut] = useState(false);        // tutorial / como usar
  const [lastCopied, setLastCopied] = useState<string[]>([]); // ids da última cópia
  const [showHidden, setShowHidden] = useState(false);  // revelar processos sem dados
  const [query, setQuery] = useState("");               // busca por nº/objeto/unidade
  const [sortBy, setSortBy] = useState<"processo" | "pendentes" | "valor">("processo");

  // Mostra o tutorial automaticamente na primeira visita
  useEffect(() => {
    chrome.storage.local.get("sadTutorialSeen", (r) => { if (!r.sadTutorialSeen) setShowTut(true); });
  }, []);
  function closeTutorial() {
    setShowTut(false);
    chrome.storage.local.set({ sadTutorialSeen: true });
  }

  function doReload() {
    reload();
    setReloaded(true);
    setTimeout(() => setReloaded(false), 1800);
  }

  // Mapeia cada processo isoladamente: um registro com estrutura inesperada
  // vira "broken" (removível) em vez de derrubar a página inteira.
  const { items, broken } = useMemo(() => {
    const ok: Item[] = [];
    const bad: string[] = [];
    for (const d of procs) {
      try {
        const ov = overrides[d.id] ?? {};
        ok.push({ id: d.id, details: d, overrides: ov, row: mapProcessToSad(d, ov, defaults) });
      } catch (e) {
        console.warn(`[Controle SAD] Processo ${d.id} ilegível:`, e);
        bad.push(d.id);
      }
    }
    return { items: ok, broken: bad };
  }, [procs, overrides, defaults]);

  // processos "sem dados" — só visitados no SEI, sem objeto/resumo (ocultos por padrão)
  const semDados = useMemo(() => items.filter((i) => !(i.row.values.objeto || "").trim()), [items]);
  // base exibida: esconde os "sem dados" a menos que o usuário peça para mostrar
  const base = useMemo(
    () => (showHidden ? items : items.filter((i) => (i.row.values.objeto || "").trim())),
    [items, showHidden]
  );

  // Busca textual + ordenação
  const filtered = useMemo(() => {
    const qn = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const valNum = (r: SadRow) => {
      const n = Number((r.values.valorEstimado ?? "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));
      return isFinite(n) ? n : 0;
    };
    let list = base;
    const q = qn(query.trim());
    if (q) {
      list = list.filter((i) =>
        qn(`${i.id} ${i.row.values.objeto ?? ""} ${i.row.values.unidadeDemandante ?? ""} ${i.row.values.contratada ?? ""}`).includes(q)
      );
    }
    if (sortBy === "pendentes") {
      list = [...list].sort((a, b) =>
        (hasPending(b.row) ? 1 : 0) - (hasPending(a.row) ? 1 : 0) ||
        b.row.missingRequired.length - a.row.missingRequired.length);
    } else if (sortBy === "valor") {
      list = [...list].sort((a, b) => valNum(b.row) - valNum(a.row));
    }
    return list;
  }, [base, query, sortBy]);

  const visible = onlyIncomplete ? filtered.filter((i) => i.row.missingRequired.length > 0) : filtered;
  const completos = base.filter((i) => i.row.missingRequired.length === 0).length;
  // progresso total de campos manuais ainda pendentes
  const totalPendentes = base.reduce((acc, i) => acc + i.row.missingRequired.length, 0);
  // processos que precisam de atenção (preencher ou conferir) — alvo do modo foco
  const pendentes = base.filter((i) => hasPending(i.row));

  // Resumo agregado para o painel do topo (só processos exibidos)
  const summary = useMemo(() => {
    let total = 0;
    const porModalidade: Record<string, number> = {};
    let comAviso = 0;
    for (const it of base) {
      const num = Number((it.row.values.valorEstimado ?? "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));
      if (isFinite(num) && num > 0) total += num;
      const mod = it.row.values.modalidade || "—";
      porModalidade[mod] = (porModalidade[mod] ?? 0) + 1;
      if (validateSadRow(it.row).length > 0) comAviso++;
    }
    const naoLancados = base.filter((i) => !launched[i.id]).length;
    return { total, porModalidade, comAviso, naoLancados };
  }, [base, launched]);

  async function copyTsv(list: Item[]) {
    const ok = await copyText(rowsToTsv(list.map((i) => i.row)));
    if (ok) setLastCopied(list.map((i) => i.id));
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), ok ? 7000 : 9000);
  }

  // ── Backup e restauração ──────────────────────────────────────────────────────
  function exportBackup() {
    chrome.storage.local.get(null, (all) => {
      const data = Object.fromEntries(Object.entries(all).filter(([k]) => isBackupKey(k)));
      const payload = { app: "sei-assistant", kind: "backup", version: 1, exportedAt: new Date().toISOString(), data };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `SEI-Assistant-backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const n = Object.keys(data).filter((k) => k.startsWith("proc_")).length;
      setNotice({ kind: "ok", text: `Backup exportado (${n} processo(s)). Guarde o arquivo em local seguro.` });
      setTimeout(() => setNotice(null), 6000);
    });
  }

  function importBackup(file: File) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const obj = JSON.parse(String(fr.result));
        if (!obj || obj.kind !== "backup" || !obj.data || typeof obj.data !== "object") {
          throw new Error("estrutura inválida");
        }
        // Só restaura chaves esperadas — um JSON adulterado não sobrescreve sessão/chave de API
        const data = Object.fromEntries(Object.entries(obj.data as Record<string, unknown>).filter(([k]) => isBackupKey(k)));
        const n = Object.keys(data).filter((k) => k.startsWith("proc_")).length;
        if (Object.keys(data).length === 0) throw new Error("nenhum dado reconhecido");
        chrome.storage.local.set(data, () => {
          reload();
          setNotice({ kind: "ok", text: `Backup restaurado: ${n} processo(s) e configurações.` });
          setTimeout(() => setNotice(null), 6000);
        });
      } catch (e) {
        setNotice({ kind: "err", text: `Não foi possível restaurar: o arquivo não parece um backup válido do SEI Assistant.` });
        setTimeout(() => setNotice(null), 8000);
        console.warn("[Controle SAD] Falha ao importar backup:", e);
      }
    };
    fr.onerror = () => {
      setNotice({ kind: "err", text: "Falha ao ler o arquivo selecionado." });
      setTimeout(() => setNotice(null), 6000);
    };
    fr.readAsText(file);
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
        <div className="sad-header-left">
          <h1 className="sad-title">Controle SAD</h1>
          {base.length > 0 && (
            <p className="sad-sub">{base.length} processos · {completos} prontos · {new Date(refreshedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p>
          )}
        </div>
        <div className="sad-actions">
          {base.length > 0 && (
            <>
              <button className="sad-btn sad-btn-focus" onClick={() => setPicking(true)}>🎯 Revisar</button>
              <button className="sad-btn sad-btn-primary" onClick={() => copyTsv(visible)} disabled={visible.length === 0}>
                📋 Copiar {visible.length}
              </button>
            </>
          )}
          <button className="sad-btn sad-btn-ghost" onClick={() => setShowTut(true)} title="Como usar esta tela">❓ Como usar</button>
          <KebabMenu
            items={[
              ...(items.length > 0 ? [
                { label: reloaded ? "✓ Atualizado" : "Recarregar dados", onClick: doReload },
                { label: "Baixar CSV", onClick: () => downloadCsv(visible) },
                { sep: true } as const,
              ] : []),
              { label: "Exportar backup (.json)", onClick: exportBackup },
              { label: "Restaurar backup…", onClick: () => importRef.current?.click() },
              ...(items.length > 0 ? [
                { sep: true } as const,
                { label: "Zerar todas as edições", onClick: () => {
                  if (confirm("Apagar todas as suas edições manuais? Os campos voltam ao valor sugerido pelo assistente.")) {
                    clearOverrides(base.map((i) => i.id));
                  }
                } },
                ...(semDados.length > 0 ? [{ label: `Limpar ${semDados.length} processo(s) sem dados`, onClick: () => {
                  if (confirm(`Remover ${semDados.length} processo(s) sem objeto/resumo? São processos apenas visitados no SEI, sem coleta completa.`)) {
                    removeProcs(semDados.map((i) => i.id));
                  }
                } }] : []),
              ] : []),
              { sep: true },
              { label: "Carregar exemplos", onClick: () => seedTestData() },
              { label: "Limpar exemplos", onClick: () => clearTestData() },
            ]}
          />
        </div>
      </header>

      {showTut && <Tutorial onClose={closeTutorial} />}

      {/* input oculto para restaurar backup */}
      <input
        ref={importRef} type="file" accept=".json,application/json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ""; }}
      />

      {copied === "ok" && (
        <div className="sad-toast">
          <span>✓ Copiado! Na planilha, clique na célula <b>A</b> da 1ª linha vazia e tecle <b>Ctrl+V</b>.</span>
          {lastCopied.length > 0 && (
            <button className="sad-toast-action" onClick={() => {
              const snaps: SnapshotMap = {};
              for (const it of items) if (lastCopied.includes(it.id)) snaps[it.id] = snapOf(it.row);
              setManyLaunched(lastCopied, true, snaps);
              setCopied(null);
            }}>
              Marcar {lastCopied.length} como lançado(s)
            </button>
          )}
        </div>
      )}
      {copied === "fail" && (
        <div className="sad-toast sad-toast--err">
          ✗ Não foi possível copiar para a área de transferência. Clique na página e tente de novo — ou use <b>⋯ → Baixar CSV</b>.
        </div>
      )}
      {notice && (
        <div className={`sad-toast ${notice.kind === "err" ? "sad-toast--err" : ""}`}>{notice.text}</div>
      )}

      {/* Registros ilegíveis no armazenamento — oferecer limpeza em vez de quebrar */}
      {(corruptedKeys.length > 0 || broken.length > 0) && (
        <div className="sad-toast sad-toast--warn">
          <span>⚠ {corruptedKeys.length + broken.length} registro(s) com dados corrompidos no armazenamento (não afetam os demais).</span>
          <button
            className="sad-toast-action"
            onClick={() => { cleanCorrupted(); if (broken.length) removeProcs(broken); }}
          >Limpar registros corrompidos</button>
        </div>
      )}

      {!loaded ? (
        <div className="sad-empty">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="sad-empty">
          <div className="sad-empty-icon">📋</div>
          <p className="sad-empty-title">Nenhum processo coletado</p>
          <p className="sad-empty-desc">Colete processos no SEI Assistant e eles aparecem aqui prontos para exportar.</p>
          <button className="sad-btn sad-btn-primary" style={{ marginTop: 18 }} onClick={() => seedTestData()}>🧪 Carregar 4 exemplos</button>
          <p className="sad-empty-note">Dados fictícios para testar sem coletar do SEI.</p>
        </div>
      ) : (
        <>
          {/* Painel-resumo */}
          <SummaryPanel summary={summary} count={base.length} />

          {/* Padrões pessoais — discreto */}
          <DefaultsBar defaults={defaults} onSave={saveDefaults} />

          {/* Busca e ordenação */}
          {base.length > 1 && (
            <div className="sad-search">
              <input
                className="sad-search-input"
                placeholder="🔎 Buscar por nº, objeto, unidade ou contratada…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="sad-search-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                <option value="processo">Ordem: nº do processo</option>
                <option value="pendentes">Ordem: pendentes primeiro</option>
                <option value="valor">Ordem: maior valor</option>
              </select>
            </div>
          )}

          {/* Barra de progresso */}
          <div className="sad-progress">
            <div className="sad-progress-track">
              <div className="sad-progress-fill" style={{ width: `${base.length ? (completos / base.length) * 100 : 0}%` }} />
            </div>
            <span className="sad-count">
              <strong>{completos}/{base.length}</strong> prontos{totalPendentes > 0 && <span className="sad-pend"> · {totalPendentes} a preencher</span>}
            </span>
            <label className="sad-filter">
              <input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} />
              Só pendentes
            </label>
          </div>

          {/* Aviso de processos sem dados ocultos */}
          {semDados.length > 0 && (
            <div className="sad-hidden-note">
              <span>👁 {semDados.length} processo(s) só visitado(s) no SEI (sem resumo) {showHidden ? "exibido(s)" : "oculto(s)"}.</span>
              <span className="sad-hidden-actions">
                <button onClick={() => setShowHidden((s) => !s)}>{showHidden ? "Ocultar" : "Mostrar"}</button>
                <button className="sad-hidden-clear" onClick={() => {
                  if (confirm(`Remover ${semDados.length} processo(s) sem resumo da extensão?`)) removeProcs(semDados.map((i) => i.id));
                }}>Limpar</button>
              </span>
            </div>
          )}

          <div className="sad-list">
            {visible.length === 0 && query.trim() && (
              <div className="sad-empty" style={{ padding: "32px 20px" }}>
                Nenhum processo corresponde a “{query.trim()}”.
              </div>
            )}
            {visible.map((it) => (
              <SadCard
                key={it.id}
                item={it}
                launchedAt={launched[it.id]}
                changes={launched[it.id] ? diffSnapshot(it.row, snapshots[it.id]) : []}
                onToggleLaunched={(v) => toggleLaunched(it.id, v, v ? snapOf(it.row) : undefined)}
                onRemove={() => { if (confirm(`Remover o processo ${it.id} da extensão?`)) removeProcs([it.id]); }}
                onField={(k, v) => setField(it.id, k, v)}
              />
            ))}
          </div>
        </>
      )}

      {/* Seleção de quais processos revisar */}
      {picking && (
        <ReviewPicker
          items={base}
          defaultSelected={pendentes.map((i) => i.id)}
          onClose={() => setPicking(false)}
          onClear={(ids) => clearOverrides(ids)}
          onStart={(ids) => { setPicking(false); setFocusIds(ids); }}
        />
      )}

      {/* Modo foco com os processos escolhidos */}
      {focusIds && (
        <FocusMode
          items={base.filter((i) => focusIds.includes(i.id))}
          onField={(id, k, v) => setField(id, k, v)}
          onClear={(id) => clearOverrides([id])}
          onClose={() => setFocusIds(null)}
          onExport={() => { copyTsv(base); setFocusIds(null); }}
        />
      )}
    </div>
  );
}

// ── Tutorial / Como usar ────────────────────────────────────────────────────────
const TUT_STEPS = [
  {
    icon: "📋",
    title: "O que é esta tela",
    body: "Ela transforma os processos que você coletou no SEI Assistant em linhas prontas da planilha de Controle SAD. O assistente já preenche a maior parte dos campos automaticamente — você só revisa e completa o que falta.",
  },
  {
    icon: "⚡",
    title: "1. Configure “Meus padrões”",
    body: "Defina uma vez o seu nome (Responsável SAD), a prioridade e a situação no PCA mais comuns. Esses valores passam a preencher sozinhos todos os processos — você não digita a mesma coisa de novo.",
  },
  {
    icon: "🏷️",
    title: "2. Entenda as marcas dos campos",
    body: "🔴 preencher = obrigatório e vazio · 🟠 confira = o assistente sugeriu, mas vale conferir · ⚪ opcional = não exigido, preencha só se tiver a informação. O que não tem marca já está preenchido.",
  },
  {
    icon: "🎯",
    title: "3. Revise no modo foco",
    body: "Clique em “Revisar”, escolha quais processos quer completar e preencha um por vez, vendo só o que falta. Use as setas ← → para navegar. Pode “Zerar” as edições de um processo para recomeçar do zero.",
  },
  {
    icon: "📎",
    title: "4. Copie para a planilha",
    body: "Clique em “Copiar”, abra a aba Acompanhamento_SAD, selecione a célula A da 1ª linha vazia e tecle Ctrl+V. As colunas calculadas (com fórmula) você arrasta depois.",
  },
];

function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const last = step >= TUT_STEPS.length - 1;
  const s = TUT_STEPS[step];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !last) setStep((x) => x + 1);
      else if (e.key === "ArrowLeft" && step > 0) setStep((x) => x - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, last]);

  return (
    <div className="focus-overlay">
      <div className="tut">
        <button className="focus-close tut-close" onClick={onClose} title="Fechar (Esc)">✕</button>
        <div className="tut-icon">{s.icon}</div>
        <h2 className="tut-title">{s.title}</h2>
        <p className="tut-body">{s.body}</p>

        <div className="tut-dots">
          {TUT_STEPS.map((_, i) => (
            <button key={i} className={`tut-dot ${i === step ? "tut-dot--on" : ""}`} onClick={() => setStep(i)} aria-label={`Passo ${i + 1}`} />
          ))}
        </div>

        <div className="tut-nav">
          <button className="sad-btn sad-btn-ghost" onClick={() => setStep((x) => x - 1)} disabled={step === 0}>← Voltar</button>
          {last ? (
            <button className="sad-btn sad-btn-primary" onClick={onClose}>Começar ✓</button>
          ) : (
            <button className="sad-btn sad-btn-primary" onClick={() => setStep((x) => x + 1)}>Próximo →</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Seletor: escolher quais processos revisar ───────────────────────────────────
function ReviewPicker({ items, defaultSelected, onStart, onClear, onClose }: {
  items: Item[];
  defaultSelected: string[];
  onStart: (ids: string[]) => void;
  onClear: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(defaultSelected));

  function toggle(id: string) {
    setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const selected = items.filter((i) => sel.has(i.id));

  return (
    <div className="focus-overlay">
      <div className="picker">
        <div className="picker-head">
          <div>
            <h2 className="picker-title">Escolha o que revisar</h2>
            <p className="picker-sub">Marque os processos que quer abrir no modo foco.</p>
          </div>
          <button className="focus-close" onClick={onClose} title="Fechar">✕</button>
        </div>

        <div className="picker-tools">
          <button className="picker-link" onClick={() => setSel(new Set(items.map((i) => i.id)))}>Todos</button>
          <button className="picker-link" onClick={() => setSel(new Set(defaultSelected))}>Só pendentes</button>
          <button className="picker-link" onClick={() => setSel(new Set())}>Nenhum</button>
        </div>

        <div className="picker-list">
          {items.map((it) => {
            const pend = hasPending(it.row);
            const checked = sel.has(it.id);
            return (
              <label key={it.id} className={`picker-item ${checked ? "picker-item--on" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(it.id)} />
                <span className="picker-item-main">
                  <span className="picker-item-id">{it.id}</span>
                  <span className="picker-item-obj">{it.row.values.objeto || "(sem objeto)"}</span>
                </span>
                <span className={`picker-badge ${pend ? "picker-badge--pend" : "picker-badge--ok"}`}>
                  {pend ? `${it.row.missingRequired.length || "•"} pendente${it.row.missingRequired.length === 1 ? "" : "s"}` : "✓ ok"}
                </span>
              </label>
            );
          })}
        </div>

        <div className="picker-footer">
          <button
            className="sad-btn sad-btn-ghost sad-btn-danger"
            disabled={selected.length === 0}
            onClick={() => {
              if (confirm(`Zerar as edições de ${selected.length} processo(s)? Os campos voltam ao valor sugerido.`)) onClear([...sel]);
            }}
          >↺ Zerar edições ({selected.length})</button>
          <button className="sad-btn sad-btn-focus" disabled={selected.length === 0} onClick={() => onStart([...sel])}>
            Revisar {selected.length} →
          </button>
        </div>
      </div>
    </div>
  );
}

// Menu "⋯" para ações secundárias (mantém o header limpo)
function KebabMenu({ items }: { items: ({ label: string; onClick: () => void } | { sep: true })[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="kebab">
      <button className="kebab-btn" onClick={() => setOpen((o) => !o)} title="Mais opções">⋯</button>
      {open && (
        <>
          <div className="kebab-backdrop" onClick={() => setOpen(false)} />
          <div className="kebab-menu">
            {items.map((it, i) =>
              "sep" in it
                ? <div key={i} className="kebab-sep" />
                : <button key={i} className="kebab-item" onClick={() => { it.onClick(); setOpen(false); }}>{it.label}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Painel-resumo do topo — visão geral rápida
function SummaryPanel({ summary, count }: {
  summary: { total: number; porModalidade: Record<string, number>; comAviso: number; naoLancados: number };
  count: number;
}) {
  const fmtBRL = (n: number) =>
    n >= 1_000_000 ? `R$ ${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`
    : n >= 1000 ? `R$ ${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`
    : `R$ ${n.toLocaleString("pt-BR")}`;
  const mods = Object.entries(summary.porModalidade).sort((a, b) => b[1] - a[1]);

  return (
    <div className="sad-summary">
      <div className="sad-sum-card">
        <span className="sad-sum-value">{fmtBRL(summary.total)}</span>
        <span className="sad-sum-label">Valor total estimado</span>
      </div>
      <div className="sad-sum-card">
        <span className="sad-sum-value">{count}</span>
        <span className="sad-sum-label">Processos</span>
        <span className="sad-sum-mods">{mods.slice(0, 3).map(([m, n]) => `${m} ${n}`).join(" · ") || "—"}</span>
      </div>
      <div className={`sad-sum-card ${summary.comAviso > 0 ? "sad-sum-card--warn" : ""}`}>
        <span className="sad-sum-value">{summary.comAviso}</span>
        <span className="sad-sum-label">Com dados a verificar</span>
      </div>
      <div className={`sad-sum-card ${summary.naoLancados > 0 ? "sad-sum-card--info" : "sad-sum-card--ok"}`}>
        <span className="sad-sum-value">{summary.naoLancados}</span>
        <span className="sad-sum-label">A lançar na planilha</span>
      </div>
    </div>
  );
}

// Barra de padrões pessoais — preenche automaticamente os campos manuais repetitivos
function DefaultsBar({ defaults, onSave }: { defaults: SadDefaults; onSave: (d: SadDefaults) => void }) {
  const [open, setOpen] = useState(false);
  const has = !!(defaults.responsavelSad || defaults.prioridade || defaults.situacaoPca);

  function set(key: keyof SadDefaults, value: string) {
    onSave({ ...defaults, [key]: value });
  }

  return (
    <div className={`sad-defaults ${has ? "sad-defaults--on" : ""}`}>
      <button className="sad-defaults-head" onClick={() => setOpen((o) => !o)}>
        <span className="sad-defaults-title">
          ⚡ Meus padrões
          {has
            ? <span className="sad-defaults-summary">{[defaults.responsavelSad, defaults.prioridade].filter(Boolean).join(" · ")}</span>
            : <span className="sad-defaults-hint">configure uma vez e preencha sozinho</span>}
        </span>
        <span className="sad-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="sad-defaults-body">
          <p className="sad-defaults-desc">Estes valores preenchem automaticamente os campos vazios de <b>todos</b> os processos. Você ainda pode mudar caso a caso.</p>
          <div className="sad-defaults-grid">
            <div className="sad-field">
              <label>Responsável SAD (você)</label>
              <select value={defaults.responsavelSad ?? ""} onChange={(e) => set("responsavelSad", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.servidores.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="sad-field">
              <label>Prioridade padrão</label>
              <select value={defaults.prioridade ?? ""} onChange={(e) => set("prioridade", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.prioridade.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="sad-field">
              <label>Situação no PCA padrão</label>
              <select value={defaults.situacaoPca ?? ""} onChange={(e) => set("situacaoPca", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.pca.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>
        </div>
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

function attentionOf(row: SadRow, key: string): Attention {
  const val = row.values[key] ?? "";
  if (REQUIRED.has(key) && !val) return "req";
  if (REVIEW_KEYS.has(key) && row.sources[key] === "inferido" && val) return "review";
  return null;
}

// Precisa de atenção: obrigatório/sugestão OU valor suspeito (validação)
function needsAttention(row: SadRow, key: string): boolean {
  return attentionOf(row, key) !== null || sadFieldIssue(row, key) !== null;
}

function hasPending(row: SadRow): boolean {
  return SAD_COLUMNS.some((c) => !c.calc && needsAttention(row, c.key));
}

function Field({ col, val, src, attention, issue, onChange }: {
  col: typeof SAD_COLUMNS[number]; val: string; src: string; attention: Attention;
  issue?: string | null; onChange: (v: string) => void;
}) {
  const meta = SAD_FIELD_META[col.key] ?? { type: "text" as const };
  const isProc = col.key === "processoSei";
  const req = REQUIRED.has(col.key);
  const hasIssue = !!issue;

  return (
    <div className={`sad-field ${hasIssue ? "sad-field--issue" : attention === "req" ? "sad-field--req" : attention === "review" ? "sad-field--review" : ""}`}>
      <label>
        <span className="sad-field-name">{req && <span className="req">★</span>}{col.letter} · {col.header}</span>
        {hasIssue && <span className="tag tag-issue">verificar</span>}
        {!hasIssue && attention === "req" && <span className="tag tag-req">preencher</span>}
        {!hasIssue && attention === "review" && <span className="tag tag-review">confira</span>}
        {!hasIssue && !attention && !val && !req && <span className="tag tag-optional">opcional</span>}
        {!hasIssue && !attention && val && <span className={`src-tag src-${src}`} />}
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
      {hasIssue && <span className="sad-field-issue-msg">⚠ {issue}</span>}
    </div>
  );
}

function SadCard({ item, launchedAt, changes = [], onToggleLaunched, onRemove, onField }: {
  item: Item;
  launchedAt?: string;
  changes?: { key: string; header: string; from: string; to: string }[];
  onToggleLaunched: (v: boolean) => void;
  onRemove: () => void;
  onField: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { row, details } = item;
  const editable = SAD_COLUMNS.filter((c) => !c.calc);

  const attentionCols = editable.filter((c) => needsAttention(row, c.key));
  const restCols = editable.filter((c) => !needsAttention(row, c.key));
  const nReq = attentionCols.filter((c) => attentionOf(row, c.key) === "req").length;
  const nReview = attentionCols.filter((c) => attentionOf(row, c.key) === "review").length;
  const issues = validateSadRow(row);
  const complete = nReq === 0;
  const launchedStr = launchedAt ? new Date(launchedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : null;

  return (
    <div className={`sad-card ${complete ? "" : "sad-card--incomplete"}`}>
      <div className="sad-card-head" onClick={() => setOpen((o) => !o)}>
        <span className="sad-card-id">{details.id}</span>
        <span className="sad-card-obj">{row.values.objeto || "(sem objeto)"}</span>
        <span className="sad-head-badges">
          {changes.length > 0 && <span className="sad-badge sad-badge--changed">🔄 {changes.length} mudou</span>}
          {launchedStr && changes.length === 0 && <span className="sad-badge sad-badge--launched">✓ lançado {launchedStr}</span>}
          {issues.length > 0 && <span className="sad-badge sad-badge--issue">{issues.length} verificar</span>}
          {nReq > 0 && <span className="sad-badge sad-badge--req">{nReq} preencher</span>}
          {nReview > 0 && <span className="sad-badge sad-badge--review">{nReview} conferir</span>}
          {complete && nReview === 0 && issues.length === 0 && <span className="sad-badge sad-badge--ok">✓ Completo</span>}
        </span>
        <span className="sad-chevron">{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div className="sad-card-body">
          {/* Mudanças desde o lançamento na planilha */}
          {changes.length > 0 && (
            <div className="sad-changes">
              <p className="sad-changes-title">🔄 Mudou desde o lançamento ({launchedStr}) — atualize a linha na planilha:</p>
              <ul className="sad-changes-list">
                {changes.map((c) => (
                  <li key={c.key}>
                    <b>{c.header}:</b> <s>{c.from || "—"}</s> → <span className="sad-changes-to">{c.to || "—"}</span>
                  </li>
                ))}
              </ul>
              <button className="sad-toast-action" onClick={() => onToggleLaunched(true)}>
                ✓ Já atualizei a planilha
              </button>
            </div>
          )}

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
                    attention={attentionOf(row, c.key)} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(c.key, v)} />
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
              <p className="sad-rest-note">
                Estes campos <b>não são exigidos</b> para exportar. Os marcados <span className="tag tag-optional">opcional</span> você preenche só se tiver a informação; os demais já foram preenchidos pelo assistente.
              </p>
              <div className="sad-grid">
                {restCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={null} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(c.key, v)} />
                ))}
              </div>
            </div>
          )}

          {/* Controle de lançamento na planilha + remover */}
          <div className="sad-launch">
            <label className="sad-launch-check">
              <input type="checkbox" checked={!!launchedAt} onChange={(e) => onToggleLaunched(e.target.checked)} />
              {launchedStr ? `Lançado na planilha em ${launchedStr}` : "Marcar como lançado na planilha"}
            </label>
            <button className="sad-remove" onClick={onRemove} title="Remover este processo da extensão">🗑 Remover</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Modo Foco — revisar/preencher um processo por vez ───────────────────────────
function FocusMode({ items, onField, onClear, onClose, onExport }: {
  items: Item[];
  onField: (id: string, key: string, value: string) => void;
  onClear: (id: string) => void;
  onClose: () => void;
  onExport: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const total = items.length;
  const item = items[Math.min(idx, total - 1)];

  const go = (d: number) => { setShowAll(false); setIdx((i) => Math.max(0, Math.min(total - 1, i + d))); };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  if (!item) {
    return (
      <div className="focus-overlay">
        <div className="focus-done">
          <div className="focus-done-icon">✓</div>
          <p className="focus-done-title">Tudo revisado!</p>
          <p className="focus-done-desc">Nenhum processo com campos pendentes.</p>
          <div className="focus-done-actions">
            <button className="sad-btn sad-btn-primary" onClick={onExport}>📋 Copiar para a planilha</button>
            <button className="sad-btn sad-btn-ghost" onClick={onClose}>Fechar</button>
          </div>
        </div>
      </div>
    );
  }

  const { row, details } = item;
  const editable = SAD_COLUMNS.filter((c) => !c.calc);
  const attentionCols = editable.filter((c) => needsAttention(row, c.key));
  const restCols = editable.filter((c) => !needsAttention(row, c.key));
  const nReq = attentionCols.filter((c) => attentionOf(row, c.key) === "req").length;
  const isLast = idx >= total - 1;
  const pct = Math.round(((idx + 1) / total) * 100);

  return (
    <div className="focus-overlay">
      <div className="focus-top">
        <span className="focus-pos">Revisão {idx + 1} de {total}</span>
        <div className="focus-bar"><div className="focus-bar-fill" style={{ width: `${pct}%` }} /></div>
        <button className="focus-close" onClick={onClose} title="Sair (Esc)">✕</button>
      </div>

      <div className="focus-body">
        <div className="focus-card">
          <div className="focus-card-top">
            <div>
              <div className="focus-proc">{details.id}</div>
              <div className="focus-obj">{row.values.objeto || "(sem objeto)"}</div>
            </div>
            <button
              className="focus-reset"
              title="Zerar minhas edições deste processo e voltar às sugestões"
              onClick={() => { if (confirm("Zerar suas edições deste processo?")) onClear(item.id); }}
            >↺ Zerar</button>
          </div>

          {attentionCols.length === 0 ? (
            <div className="focus-allgood">✓ Este processo já está completo.</div>
          ) : (
            <>
              <p className="focus-fields-title">
                {nReq > 0 ? `Preencha os ${nReq} campo(s) obrigatório(s)` : "Confira as sugestões"}
              </p>
              <div className="focus-fields">
                {attentionCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={attentionOf(row, c.key)} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(item.id, c.key, v)} />
                ))}
              </div>
            </>
          )}

          <button className="sad-toggle-all" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "▾ Ocultar demais campos" : `▸ Ver/editar demais campos (${restCols.length})`}
          </button>
          {showAll && (
            <div className="focus-fields">
              {restCols.map((c) => (
                <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                  attention={null} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(item.id, c.key, v)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="focus-nav">
        <button className="sad-btn sad-btn-ghost" onClick={() => go(-1)} disabled={idx === 0}>← Anterior</button>
        <span className="focus-hint">use ← → para navegar</span>
        {isLast ? (
          <button className="sad-btn sad-btn-primary" onClick={onExport}>✓ Concluir e copiar</button>
        ) : (
          <button className="sad-btn sad-btn-primary" onClick={() => go(1)}>Próximo →</button>
        )}
      </div>
    </div>
  );
}

// ── Rede de segurança da página: erro inesperado não vira tela branca ───────────
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("[Controle SAD] Erro de renderização:", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="sad">
        <div className="sad-empty">
          <div className="sad-empty-icon">⚠️</div>
          <p className="sad-empty-title">Algo deu errado ao montar a tela</p>
          <p className="sad-empty-desc">
            Seus dados continuam salvos. Recarregue a página — se o problema persistir,
            use “Restaurar backup” ou limpe os registros corrompidos.
          </p>
          <button className="sad-btn sad-btn-primary" style={{ marginTop: 18 }} onClick={() => location.reload()}>
            ↻ Recarregar página
          </button>
          <p className="sad-empty-note">{String(this.state.error)}</p>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ErrorBoundary><ControleSad /></ErrorBoundary></StrictMode>
);
