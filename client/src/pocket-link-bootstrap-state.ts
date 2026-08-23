import type { PocketLinkDiscoveryCandidate } from "./pocket-link-discovery";
import {
  matchesPocketLinkConnection,
  type PendingPocketLinkBootstrap,
} from "./pocket-link-pairing";

export type PocketLinkBootstrapPhase = "idle" | "scanning_qr" | "discovering_lan";

export interface PocketLinkBootstrapState {
  phase: PocketLinkBootstrapPhase;
  discoveryCandidates: PocketLinkDiscoveryCandidate[];
  selectedDiscovery: PocketLinkDiscoveryCandidate | null;
  pendingQr: PendingPocketLinkBootstrap | null;
}

export type PocketLinkBootstrapAction =
  | { type: "start_qr" }
  | { type: "review_qr"; bootstrap: PendingPocketLinkBootstrap }
  | { type: "finish_qr" }
  | { type: "start_discovery" }
  | { type: "review_discovery"; candidates: PocketLinkDiscoveryCandidate[] }
  | { type: "finish_discovery" }
  | { type: "select_discovery"; candidate: PocketLinkDiscoveryCandidate; now: number }
  | { type: "invalidate_discovery" }
  | {
      type: "register";
      targetId: string;
      pocketLink: boolean;
      host: string;
      port: number;
      serverPublicKeyPin: string;
    }
  | { type: "clear_qr" };

export const initialPocketLinkBootstrapState: PocketLinkBootstrapState = {
  phase: "idle",
  discoveryCandidates: [],
  selectedDiscovery: null,
  pendingQr: null,
};

export function reducePocketLinkBootstrap(
  state: PocketLinkBootstrapState,
  action: PocketLinkBootstrapAction,
): PocketLinkBootstrapState {
  switch (action.type) {
    case "start_qr":
      if (state.phase !== "idle") return state;
      return { ...initialPocketLinkBootstrapState, phase: "scanning_qr" };
    case "review_qr":
      if (state.phase !== "scanning_qr") return state;
      return { ...initialPocketLinkBootstrapState, pendingQr: action.bootstrap };
    case "finish_qr":
      return state.phase === "scanning_qr"
        ? initialPocketLinkBootstrapState
        : state;
    case "start_discovery":
      if (state.phase !== "idle") return state;
      return { ...initialPocketLinkBootstrapState, phase: "discovering_lan" };
    case "review_discovery":
      if (state.phase !== "discovering_lan") return state;
      return {
        ...initialPocketLinkBootstrapState,
        discoveryCandidates: [...action.candidates],
      };
    case "finish_discovery":
      return state.phase === "discovering_lan"
        ? initialPocketLinkBootstrapState
        : state;
    case "select_discovery": {
      if (state.phase !== "idle" || action.now >= action.candidate.expiresAt
          || !state.discoveryCandidates.some((candidate) => sameCandidate(candidate, action.candidate))) return state;
      return {
        ...state,
        selectedDiscovery: action.candidate,
        pendingQr: null,
      };
    }
    case "invalidate_discovery":
      return state.selectedDiscovery === null ? state : { ...state, selectedDiscovery: null };
    case "register": {
      const pendingQr = action.pocketLink && matchesPocketLinkConnection(
        state.pendingQr,
        action.host,
        action.port,
        action.serverPublicKeyPin,
      ) ? { ...state.pendingQr, targetId: action.targetId } : null;
      return { ...initialPocketLinkBootstrapState, pendingQr };
    }
    case "clear_qr":
      return state.pendingQr === null ? state : { ...state, pendingQr: null };
  }
}

function sameCandidate(
  left: PocketLinkDiscoveryCandidate,
  right: PocketLinkDiscoveryCandidate,
): boolean {
  return left.name === right.name
    && left.host === right.host
    && left.port === right.port
    && left.expiresAt === right.expiresAt;
}
