export type ProcessStatus = "received" | "pending" | "completed" | "paused";

export interface SeiProcess {
  id: string;             // ex: "00030695-05.2025.8.17.8017"
  status: ProcessStatus;
  tag: string | null;     // ex: "BID", "plme"
  collectedAt: number;    // timestamp
}
