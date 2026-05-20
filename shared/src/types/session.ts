export type SessionStatus = "idle" | "detected" | "loading" | "error" | "expired";

export interface SessionInfo {
  status: SessionStatus;
  username: string | null;
  unit: string | null;     // ex: "COORD. AQUISIÇÕES - BID"
  detectedAt: number | null; // timestamp
}
