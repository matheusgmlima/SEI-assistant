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
  | "OPEN_DASHBOARD";

export interface ExtMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}
