/**
 * extension/src/db/index.ts
 *
 * Banco de dados local via IndexedDB (lib idb).
 * Persiste indefinidamente — não reseta ao fechar o browser.
 *
 * Schemas:
 *   processos  { id, tipo, descricao, unidade_atual, partes, atualizado_em }
 *   despachos  { id_doc (PK), processo_id, titulo, data, setor, conteudo }
 *   andamentos { id (auto), processo_id, data, unidade, descricao }
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// ─── Schema ────────────────────────────────────────────────────────────────────

export interface ProcessoRecord {
  id: string;               // número formatado "0001234-12.2024.8.17.0000"
  tipo: string | null;
  descricao: string | null;
  unidade_atual: string | null;
  partes: string[];
  ultimo_doc_titulo: string | null;   // título do último despacho (para sync incremental)
  atualizado_em: number;              // timestamp
}

export interface DespachoRecord {
  id_doc: string;           // ID numérico do documento SEI (ex: "3341475")
  processo_id: string;
  titulo: string;           // "Despacho 3341475 UGP - BID"
  data: string | null;      // extraída do andamento
  setor: string | null;     // unidade mandante
  conteudo: string | null;  // texto do despacho (quando disponível)
}

export interface AndamentoRecord {
  id?: number;              // auto-increment
  processo_id: string;
  data: string;
  unidade: string;
  descricao: string;
}

interface SeiDB extends DBSchema {
  processos: {
    key: string;
    value: ProcessoRecord;
    indexes: { by_atualizado: number };
  };
  despachos: {
    key: string;            // id_doc
    value: DespachoRecord;
    indexes: { by_processo: string };
  };
  andamentos: {
    key: number;
    value: AndamentoRecord;
    indexes: { by_processo: string };
  };
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

let _db: IDBPDatabase<SeiDB> | null = null;

export async function getDb(): Promise<IDBPDatabase<SeiDB>> {
  if (_db) return _db;

  _db = await openDB<SeiDB>("sei-assistant", 1, {
    upgrade(db) {
      // processos
      const proc = db.createObjectStore("processos", { keyPath: "id" });
      proc.createIndex("by_atualizado", "atualizado_em");

      // despachos
      const desp = db.createObjectStore("despachos", { keyPath: "id_doc" });
      desp.createIndex("by_processo", "processo_id");

      // andamentos
      const and = db.createObjectStore("andamentos", {
        keyPath: "id",
        autoIncrement: true,
      });
      and.createIndex("by_processo", "processo_id");
    },
  });

  return _db;
}

// ─── API de processos ──────────────────────────────────────────────────────────

export async function upsertProcesso(p: ProcessoRecord): Promise<void> {
  const db = await getDb();
  await db.put("processos", p);
}

export async function getProcesso(id: string): Promise<ProcessoRecord | undefined> {
  const db = await getDb();
  return db.get("processos", id);
}

export async function getAllProcessos(): Promise<ProcessoRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("processos", "by_atualizado");
}

// ─── API de despachos ──────────────────────────────────────────────────────────

export async function upsertDespacho(d: DespachoRecord): Promise<void> {
  const db = await getDb();
  await db.put("despachos", d);
}

export async function getDespachosByProcesso(processoId: string): Promise<DespachoRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("despachos", "by_processo", processoId);
}

export async function getUltimoDespacho(processoId: string): Promise<DespachoRecord | undefined> {
  const despachos = await getDespachosByProcesso(processoId);
  // ordena por id_doc numérico desc — o maior id é o mais recente
  return despachos.sort((a, b) => Number(b.id_doc) - Number(a.id_doc))[0];
}

// ─── API de andamentos ─────────────────────────────────────────────────────────

export async function replaceAndamentos(
  processoId: string,
  entries: Omit<AndamentoRecord, "id" | "processo_id">[]
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("andamentos", "readwrite");

  // Remove os antigos
  const existing = await tx.store.index("by_processo").getAllKeys(processoId);
  await Promise.all(existing.map((k) => tx.store.delete(k)));

  // Insere os novos
  await Promise.all(
    entries.map((e) => tx.store.add({ ...e, processo_id: processoId }))
  );

  await tx.done;
}

export async function getAndamentosByProcesso(processoId: string): Promise<AndamentoRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("andamentos", "by_processo", processoId);
}

// ─── Sync incremental ──────────────────────────────────────────────────────────
// Retorna true se os documentos mudaram (novo despacho adicionado)

export async function needsSync(processoId: string, ultimoDocTitulo: string | null): Promise<boolean> {
  if (!ultimoDocTitulo) return true;
  const proc = await getProcesso(processoId);
  if (!proc) return true;
  return proc.ultimo_doc_titulo !== ultimoDocTitulo;
}
