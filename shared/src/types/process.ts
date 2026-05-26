export type ProcessStatus = "received" | "pending" | "completed" | "paused";

export interface SeiProcess {
  id: string;
  status: ProcessStatus;
  tag: string | null;
  collectedAt: number;
  type: string | null;
  lastUpdate: string | null;
  assignedTo: string | null;
  description: string | null;
}

export interface AndamentoEntry {
  date: string;
  description: string;
  unit: string;
}

export interface ProcessDetails {
  id: string;
  type: string | null;
  description: string | null;
  currentUnit: string | null;
  parties: string[];
  documents: string[];
  andamento: AndamentoEntry[];
  extractedAt: number;
  summary: string | null; // resumo gerado pela IA, cacheado
  despachosContent: string | null; // texto concatenado dos despachos
  documentLinks: Record<string, string>; // título -> URL completa com hash correto
}
