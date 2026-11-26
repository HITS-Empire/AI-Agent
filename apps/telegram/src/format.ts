import { PROJECT_NAME } from "@burmalda/shared";

/** Название «бурмалда» в каждом исходящем сообщении. */
export function formatOwnerReply(text: string): string {
  return `${PROJECT_NAME}\n${text}`;
}

export function isOwner(fromId: number | undefined, ownerId: string): boolean {
  return ownerId.length > 0 && String(fromId ?? "") === ownerId;
}

export function approvalButtons(requestId: string): {
  yes: string;
  no: string;
} {
  return { yes: `apr:${requestId}:y`, no: `apr:${requestId}:n` };
}

export function parseApprovalCallback(
  data: string,
): { requestId: string; approved: boolean } | undefined {
  const match = /^apr:([0-9a-fA-F-]{36}):([yn])$/.exec(data);
  if (!match) return undefined;
  return { requestId: match[1]!, approved: match[2] === "y" };
}
