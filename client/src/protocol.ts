export const CLIENT_PROTOCOL_MINIMUM = 2;
export const CLIENT_PROTOCOL_MAXIMUM = 3;

export function assertCompatibleProtocol(serverProtocol: number, minimumClientProtocol: number): void {
  if (minimumClientProtocol > CLIENT_PROTOCOL_MAXIMUM || serverProtocol < CLIENT_PROTOCOL_MINIMUM) {
    throw new Error(
      `앱과 Companion 프로토콜이 호환되지 않습니다. 앱 ${CLIENT_PROTOCOL_MINIMUM}-${CLIENT_PROTOCOL_MAXIMUM}, 서버 ${serverProtocol}`,
    );
  }
}
