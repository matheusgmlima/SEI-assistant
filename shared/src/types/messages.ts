/**
 * Mensagens trocadas entre content script ↔ background ↔ sidebar
 */

export type MessageType =
  | "SESSION_DETECTED"
  | "SESSION_ENDED"
  | "GET_SESSION"
  | "COLLECT_PROCESSES"
  | "PROCESSES_COLLECTED"
  | "SUMMARIZE_PROCESS"
  | "OPEN_DASHBOARD"
  | "EXPAND_TREE"
  | "GET_ANDAMENTO"
  | "GET_DB_ANDAMENTO"
  | "CHECK_SYNC"
  | "START_COLLECTION"
  | "STOP_COLLECTION"
  | "COLLECTION_DONE"
  | "AUDIT_PROCESS"
  | "ASK_PROCESS"
  | "START_QUEUE"
  | "STOP_QUEUE";

/** Estado da fila de coleta em lote (persistido em storage `collectionQueue`). */
export interface CollectionQueueState {
  current: string | null;  // processo sendo coletado agora
  remaining: string[];     // ainda na fila
  done: string[];          // coletados com sucesso
  failed: string[];        // falharam
  total: number;           // total inicial
  status: "running" | "done";
  startedAt: number;
}

export interface CollectionStatus {
  processId: string;
  status: "running" | "done" | "error";
  phase: string;
  step: number;
  totalSteps: number;
  startedAt: number;
  error?: string;
}

export interface ExtMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}
