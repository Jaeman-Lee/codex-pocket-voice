import type { DeviceId, Operation } from "./types";

export interface RunActivityState {
  running: boolean;
  text: string;
  detail: string;
}

export interface ActiveRunState {
  generation: number;
  device: DeviceId;
  requestId: string | null;
  operation: Operation | null;
  activity: RunActivityState;
  liveMessageId: string | null;
  liveText: string;
  latestDiff: string;
}

export interface ActiveRunScope {
  generation: number;
  device: DeviceId;
}

interface ScopedAction extends ActiveRunScope {}

interface OwnedAction extends ScopedAction {
  requestId?: string;
  operationId?: string;
}

export type ActiveRunAction =
  | (ScopedAction & {
      type: "begin";
      requestId?: string;
      liveMessageId?: string;
      activity?: RunActivityState;
    })
  | (OwnedAction & { type: "adopt"; operation: Operation })
  | (OwnedAction & { type: "update"; operation: Operation })
  | (OwnedAction & { type: "set_activity"; activity: RunActivityState })
  | (OwnedAction & { type: "set_live_message"; messageId: string })
  | (OwnedAction & { type: "append_output"; messageId: string; delta: string })
  | (OwnedAction & { type: "set_diff"; diff: string })
  | (OwnedAction & { type: "mark_unknown"; operation: Operation })
  | (OwnedAction & { type: "finish" })
  | (OwnedAction & { type: "acknowledge" });

const IDLE_ACTIVITY: RunActivityState = { running: false, text: "", detail: "" };

export function initialActiveRunState(device: DeviceId): ActiveRunState {
  return {
    generation: 0,
    device,
    requestId: null,
    operation: null,
    activity: IDLE_ACTIVITY,
    liveMessageId: null,
    liveText: "",
    latestDiff: "",
  };
}

export function reduceActiveRun(state: ActiveRunState, action: ActiveRunAction): ActiveRunState {
  if (action.type === "begin") {
    if (!Number.isSafeInteger(action.generation) || action.generation <= state.generation) return state;
    return {
      generation: action.generation,
      device: action.device,
      requestId: action.requestId ?? null,
      operation: null,
      activity: action.activity ?? IDLE_ACTIVITY,
      liveMessageId: action.liveMessageId ?? null,
      liveText: "",
      latestDiff: "",
    };
  }
  if (!activeRunScopeMatches(state, action)) return state;
  if (action.type === "adopt") {
    if (action.requestId !== undefined && state.requestId !== action.requestId) return state;
    if (action.requestId === undefined && (state.requestId !== null || state.operation !== null)) return state;
  } else if (!ownerMatches(state, action)) {
    return state;
  }

  switch (action.type) {
    case "adopt":
      if (action.operationId !== undefined && action.operation.id !== action.operationId) return state;
      return {
        ...state,
        requestId: null,
        operation: action.operation,
      };
    case "update":
      if (!state.operation || action.operation.id !== state.operation.id) return state;
      return { ...state, operation: action.operation };
    case "set_activity":
      return { ...state, activity: action.activity };
    case "set_live_message":
      return { ...state, liveMessageId: state.liveMessageId ?? action.messageId };
    case "append_output":
      return {
        ...state,
        liveMessageId: state.liveMessageId ?? action.messageId,
        liveText: state.liveText + action.delta,
      };
    case "set_diff":
      return { ...state, latestDiff: action.diff };
    case "mark_unknown":
      if (!state.operation || action.operation.id !== state.operation.id) return state;
      return {
        ...state,
        operation: action.operation,
        activity: IDLE_ACTIVITY,
        liveMessageId: null,
        liveText: "",
        latestDiff: "",
      };
    case "finish":
    case "acknowledge":
      return {
        ...state,
        requestId: null,
        operation: null,
        activity: IDLE_ACTIVITY,
        liveMessageId: null,
        liveText: "",
        latestDiff: "",
      };
  }
}

export function activeRunScope(state: ActiveRunState): ActiveRunScope {
  return { generation: state.generation, device: state.device };
}

export function activeRunScopeMatches(state: ActiveRunState, scope: ActiveRunScope): boolean {
  return state.generation === scope.generation && state.device === scope.device;
}

export function activeRunOwnsOperation(
  state: ActiveRunState,
  scope: ActiveRunScope,
  operationId: string,
): boolean {
  return activeRunScopeMatches(state, scope) && state.operation?.id === operationId;
}

function ownerMatches(state: ActiveRunState, action: OwnedAction): boolean {
  if (action.requestId !== undefined && state.requestId !== action.requestId) return false;
  if (action.operationId !== undefined && state.operation?.id !== action.operationId) return false;
  return action.requestId !== undefined || action.operationId !== undefined;
}
