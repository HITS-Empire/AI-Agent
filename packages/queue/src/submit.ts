import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTask, Channel } from "@burmalda/shared";
import type { Queue } from "bullmq";

/** Одна сессия владельца на все каналы: начатое в Telegram продолжается в CLI. */
export function ownerSession(): { ownerId: string; sessionId: string } {
  const ownerId = process.env.BURMALDA_OWNER_ID?.trim() || "owner";
  const sessionId =
    process.env.BURMALDA_SESSION_ID?.trim() || `${ownerId}:main`;
  return { ownerId, sessionId };
}

export async function enqueueAgentTask(
  queue: Queue<AgentTask>,
  input: {
    sessionId: string;
    channel: Channel;
    text: string;
    taskId?: string;
  },
): Promise<AgentTask> {
  const task: AgentTask = {
    taskId: input.taskId ?? randomUUID(),
    sessionId: input.sessionId,
    channel: input.channel,
    text: input.text,
    createdAt: new Date().toISOString(),
  };
  await queue.add("task", task, {
    removeOnComplete: 200,
    removeOnFail: 100,
  });
  return task;
}

export interface TurnState {
  taskId: string;
  text: string;
  status: "running" | "done" | "error";
  error?: string;
}

/** Собрать итог задачи из событий шины. Чужие taskId игнорируются. */
export function reduceTurn(state: TurnState, event: AgentEvent): TurnState {
  if (event.taskId !== state.taskId) return state;
  if (event.type === "message") return { ...state, text: event.text };
  if (event.type === "error") {
    return { ...state, status: "error", error: event.text };
  }
  if (event.type === "done") return { ...state, status: "done" };
  return state;
}
