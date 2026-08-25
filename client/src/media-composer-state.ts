import type { MediaItem, PendingAttachment } from "./types";

export const MAX_COMPOSER_ATTACHMENTS = 4;

export interface MediaComposerState {
  attachments: PendingAttachment[];
  activeUploadBatches: number;
}

export type MediaComposerAction =
  | { type: "begin_upload_batch" }
  | { type: "finish_upload_batch" }
  | { type: "add_placeholder"; attachment: PendingAttachment }
  | { type: "upload_progress"; id: string; progress: number }
  | { type: "upload_complete"; placeholderId: string; media: MediaItem; previewUrl?: string }
  | { type: "server_update"; media: MediaItem }
  | { type: "remove"; id: string }
  | { type: "clear" };

export const initialMediaComposerState: MediaComposerState = {
  attachments: [],
  activeUploadBatches: 0,
};

export function reduceMediaComposer(
  state: MediaComposerState,
  action: MediaComposerAction,
): MediaComposerState {
  switch (action.type) {
    case "begin_upload_batch":
      return { ...state, activeUploadBatches: state.activeUploadBatches + 1 };
    case "finish_upload_batch":
      return state.activeUploadBatches === 0
        ? state
        : { ...state, activeUploadBatches: state.activeUploadBatches - 1 };
    case "add_placeholder":
      if (state.attachments.length >= MAX_COMPOSER_ATTACHMENTS
          || state.attachments.some((item) => item.id === action.attachment.id)) return state;
      return { ...state, attachments: [...state.attachments, action.attachment] };
    case "upload_progress": {
      if (!Number.isFinite(action.progress)) return state;
      const progress = Math.max(0, Math.min(100, action.progress));
      return mapAttachment(state, action.id, (item) => ({ ...item, progress }));
    }
    case "upload_complete":
      return mapAttachment(state, action.placeholderId, () => ({
        ...action.media,
        previewUrl: action.previewUrl,
        progress: 100,
      }));
    case "server_update":
      return mapAttachment(state, action.media.id, (item) => ({
        ...item,
        ...action.media,
        previewUrl: item.previewUrl,
      }));
    case "remove": {
      const attachments = state.attachments.filter((item) => item.id !== action.id);
      return attachments.length === state.attachments.length ? state : { ...state, attachments };
    }
    case "clear":
      return state.attachments.length === 0 ? state : { ...state, attachments: [] };
  }
}

export function mediaComposerBusy(state: MediaComposerState): boolean {
  return state.activeUploadBatches > 0;
}

function mapAttachment(
  state: MediaComposerState,
  id: string,
  update: (attachment: PendingAttachment) => PendingAttachment,
): MediaComposerState {
  let matched = false;
  const attachments = state.attachments.map((item) => {
    if (item.id !== id) return item;
    matched = true;
    return update(item);
  });
  return matched ? { ...state, attachments } : state;
}
