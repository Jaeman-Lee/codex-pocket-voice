export interface VoiceInputState {
  supported: boolean;
  dictating: boolean;
  handsFree: boolean;
}

export type VoiceInputAction =
  | { type: "support_changed"; supported: boolean }
  | { type: "begin"; continuous: boolean }
  | { type: "recognition_active" }
  | { type: "recognition_idle" }
  | { type: "stop" }
  | { type: "fatal_error" };

export const initialVoiceInputState: VoiceInputState = {
  supported: true,
  dictating: false,
  handsFree: false,
};

export function reduceVoiceInput(state: VoiceInputState, action: VoiceInputAction): VoiceInputState {
  switch (action.type) {
    case "support_changed":
      if (action.supported) return state.supported ? state : { ...state, supported: true };
      return { supported: false, dictating: false, handsFree: false };
    case "begin":
      if (!state.supported || state.dictating || state.handsFree) return state;
      return { ...state, dictating: true, handsFree: action.continuous };
    case "recognition_active":
      return state.supported && !state.dictating ? { ...state, dictating: true } : state;
    case "recognition_idle":
      return state.handsFree || !state.dictating ? state : { ...state, dictating: false };
    case "stop":
    case "fatal_error":
      return !state.dictating && !state.handsFree
        ? state
        : { ...state, dictating: false, handsFree: false };
  }
}
