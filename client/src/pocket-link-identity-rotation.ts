export type PocketLinkIdentityRotationResult = "completed" | "aborted";

export interface PocketLinkIdentityRotationPorts {
  hasStoredApproval(): Promise<boolean>;
  waitForPendingIdentity(): Promise<void>;
  inspectRemote(): Promise<{ status: "pending" | "completed" }>;
  completeRemote(): Promise<{ status: "pending" | "completed" }>;
  finalizeRemote(): Promise<{ finalized: boolean }>;
  abortRemote(): Promise<void>;
  isNewIdentityAuthorized(): Promise<boolean>;
  commitLocal(): Promise<void>;
  abortLocal(): Promise<void>;
}

export async function finishPocketLinkIdentityRotationFlow(
  ports: PocketLinkIdentityRotationPorts,
): Promise<PocketLinkIdentityRotationResult> {
  if (!await ports.hasStoredApproval()) {
    throw new Error("보안 저장소의 PocketLink key 교체 승인을 찾을 수 없습니다.");
  }
  await ports.waitForPendingIdentity();
  let remoteState: { status: "pending" | "completed" };
  try {
    remoteState = await ports.inspectRemote();
  } catch (error) {
    if (errorCode(error) === "TLS_KEY_ROTATION_EXPIRED") {
      await ports.abortLocal();
      return "aborted";
    }
    if (errorCode(error) === "TLS_KEY_ROTATION_NOT_PENDING") {
      return reconcileMissingRemoteRotation(ports);
    }
    throw error;
  }
  if (remoteState.status === "pending") remoteState = await ports.completeRemote();
  if (remoteState.status !== "completed") {
    throw new Error("Companion이 새 PocketLink 단말 key를 확정하지 않았습니다.");
  }
  const finalized = await ports.finalizeRemote();
  if (!finalized.finalized) throw new Error("Companion의 PocketLink key 교체 기록을 정리하지 못했습니다.");
  await ports.commitLocal();
  return "completed";
}

export async function abortPocketLinkIdentityRotationFlow(
  ports: PocketLinkIdentityRotationPorts,
): Promise<PocketLinkIdentityRotationResult> {
  try {
    await ports.abortRemote();
  } catch (error) {
    if (errorCode(error) === "TLS_KEY_ROTATION_ALREADY_COMPLETED") {
      return finishPocketLinkIdentityRotationFlow(ports);
    }
    if (errorCode(error) === "TLS_KEY_ROTATION_EXPIRED") {
      await ports.abortLocal();
      return "aborted";
    }
    if (errorCode(error) === "TLS_KEY_ROTATION_NOT_PENDING") {
      return reconcileMissingRemoteRotation(ports);
    }
    throw error;
  }
  await ports.abortLocal();
  return "aborted";
}

async function reconcileMissingRemoteRotation(
  ports: PocketLinkIdentityRotationPorts,
): Promise<PocketLinkIdentityRotationResult> {
  if (await ports.isNewIdentityAuthorized()) {
    await ports.commitLocal();
    return "completed";
  }
  await ports.abortLocal();
  return "aborted";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
