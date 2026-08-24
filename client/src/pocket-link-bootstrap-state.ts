import type { PocketLinkDiscoveryCandidate } from "./pocket-link-discovery";
import type { PocketLinkP2pCandidate } from "./pocket-link-p2p";
import {
  matchesPocketLinkConnection,
  type PendingPocketLinkBootstrap,
} from "./pocket-link-pairing";

export type PocketLinkBootstrapPhase = "idle" | "scanning_qr" | "discovering_lan" | "discovering_p2p";

export interface PocketLinkBootstrapState {
  phase: PocketLinkBootstrapPhase;
  discoveryCandidates: PocketLinkDiscoveryCandidate[];
  selectedDiscovery: PocketLinkDiscoveryCandidate | null;
  p2pCandidates: PocketLinkP2pCandidate[];
  selectedP2p: PocketLinkP2pCandidate | null;
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
  | { type: "start_p2p" }
  | { type: "review_p2p"; candidates: PocketLinkP2pCandidate[] }
  | { type: "finish_p2p" }
  | { type: "select_p2p"; candidate: PocketLinkP2pCandidate; now: number }
  | { type: "invalidate_p2p" }
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
  p2pCandidates: [],
  selectedP2p: null,
  pendingQr: null,
};

export function reducePocketLinkBootstrap(
  state: PocketLinkBootstrapState,
  action: PocketLinkBootstrapAction,
): PocketLinkBootstrapState {
  switch (action.type) {
    case "start_qr":
      if (state.phase !== "idle") return state;
      return retainP2p(state, { ...initialPocketLinkBootstrapState, phase: "scanning_qr" });
    case "review_qr":
      if (state.phase !== "scanning_qr") return state;
      return retainP2p(state, { ...initialPocketLinkBootstrapState, pendingQr: action.bootstrap });
    case "finish_qr":
      return state.phase === "scanning_qr"
        ? retainP2p(state, initialPocketLinkBootstrapState)
        : state;
    case "start_discovery":
      if (state.phase !== "idle") return state;
      return retainP2p(state, { ...initialPocketLinkBootstrapState, phase: "discovering_lan" });
    case "review_discovery":
      if (state.phase !== "discovering_lan") return state;
      return {
        ...initialPocketLinkBootstrapState,
        p2pCandidates: state.p2pCandidates,
        selectedP2p: state.selectedP2p,
        discoveryCandidates: [...action.candidates],
      };
    case "finish_discovery":
      return state.phase === "discovering_lan"
        ? retainP2p(state, initialPocketLinkBootstrapState)
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
    case "start_p2p":
      if (state.phase !== "idle") return state;
      return { ...state, phase: "discovering_p2p", p2pCandidates: [], selectedP2p: null };
    case "review_p2p":
      if (state.phase !== "discovering_p2p") return state;
      return { ...state, phase: "idle", p2pCandidates: [...action.candidates], selectedP2p: null };
    case "finish_p2p":
      return state.phase === "discovering_p2p" ? { ...state, phase: "idle" } : state;
    case "select_p2p":
      if (state.phase !== "idle" || action.now >= action.candidate.expiresAt
          || !state.p2pCandidates.some((candidate) => sameP2pCandidate(candidate, action.candidate))) return state;
      return { ...state, selectedP2p: action.candidate };
    case "invalidate_p2p":
      return state.selectedP2p === null ? state : { ...state, selectedP2p: null };
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

function retainP2p(
  state: PocketLinkBootstrapState,
  next: PocketLinkBootstrapState,
): PocketLinkBootstrapState {
  return { ...next, p2pCandidates: state.p2pCandidates, selectedP2p: state.selectedP2p };
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

function sameP2pCandidate(left: PocketLinkP2pCandidate, right: PocketLinkP2pCandidate): boolean {
  return left.id === right.id && left.name === right.name && left.expiresAt === right.expiresAt;
}
