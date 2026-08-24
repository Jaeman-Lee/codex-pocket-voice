import type { ConnectionStatus, DeviceId } from "./types";

export type ConnectionPhase =
  | "preparing"
  | "online"
  | "pairing_required"
  | "identity_rotation_required"
  | "reconnecting"
  | "failed";

export interface ConnectionState {
  attempt: number;
  device: DeviceId;
  phase: ConnectionPhase;
  status: ConnectionStatus;
  text: string;
}

interface AttemptAction {
  attempt: number;
  device: DeviceId;
}

export type ConnectionAction =
  | (AttemptAction & { type: "begin"; label: string })
  | (AttemptAction & { type: "initialized"; text: string })
  | (AttemptAction & { type: "stream_online"; label: string })
  | (AttemptAction & { type: "pairing_required" })
  | (AttemptAction & { type: "identity_rotation_required" })
  | (AttemptAction & { type: "reconnecting" })
  | (AttemptAction & { type: "failed"; label: string });

export function initialConnectionState(device: DeviceId, label: string): ConnectionState {
  return {
    attempt: 0,
    device,
    phase: "preparing",
    status: "pending",
    text: `${label} 연결을 준비하는 중…`,
  };
}

export function reduceConnection(state: ConnectionState, action: ConnectionAction): ConnectionState {
  if (action.type === "begin") {
    if (!Number.isSafeInteger(action.attempt) || action.attempt <= state.attempt) return state;
    return {
      attempt: action.attempt,
      device: action.device,
      phase: "preparing",
      status: "pending",
      text: `${action.label} 연결을 준비하는 중…`,
    };
  }
  if (action.attempt !== state.attempt || action.device !== state.device) return state;
  switch (action.type) {
    case "initialized":
      return { ...state, phase: "online", status: "online", text: action.text };
    case "stream_online":
      return {
        ...state,
        phase: "online",
        status: "online",
        text: state.phase === "reconnecting" || state.phase === "failed"
          ? `${action.label}와 안전하게 연결됨`
          : state.text,
      };
    case "pairing_required":
      return { ...state, phase: "pairing_required", status: "pending", text: "페어링 필요" };
    case "identity_rotation_required":
      return {
        ...state,
        phase: "identity_rotation_required",
        status: "pending",
        text: "PocketLink 단말 key 교체 확인 필요",
      };
    case "reconnecting":
      return { ...state, phase: "reconnecting", status: "pending", text: "연결을 복구하는 중…" };
    case "failed":
      return { ...state, phase: "failed", status: "error", text: `${action.label} 연결 실패` };
  }
}
