import type { Task, TaskState } from "../src/taskqueue.ts";

// The routes of the on-bus operations that answer 202 with their queued task (a read-back, a dry run,
// a write), driven the way a client drives them: the POST, then the task to its end. A refusal before
// queueing is the POST's own answer and has no task.
type Api<S> = (req: Request, state: S) => Promise<Response | null>;
interface QueueState { queue: { wait(id: string): Promise<Task | null> } }
export interface TaskError { code: string | null; message: string | null; details?: Record<string, unknown> }
export interface Settled { status: number; state?: TaskState; task?: Task; result?: unknown; error?: TaskError }

export async function settle<S extends QueueState>(handleApi: Api<S>, state: S, path: string, body?: unknown): Promise<Settled> {
  const res = (await handleApi(new Request(`http://x${path}`, {
    method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), state))!;
  const json = (await res.json()) as Task & { error?: TaskError | string | null };
  if (res.status !== 202) return { status: res.status, error: json.error as TaskError };
  const task = (await state.queue.wait(json.id))!;
  return {
    status: res.status, state: task.state, task, result: task.result ?? undefined,
    ...(task.state === "error" ? { error: { code: task.errorCode, message: task.error, ...(task.errorDetails ? { details: task.errorDetails } : {}) } } : {}),
  };
}

// A read-back as the device page sees it: what the read covered is the task's result, the device's
// view (linkBaseGaps among it) is fetched once the task ended.
export async function readBackAs<S extends QueueState>(handleApi: Api<S>, state: S, devicePath: string, body?: unknown) {
  const r = await settle(handleApi, state, `${devicePath}/read-back`, body);
  const view = r.state === "done" ? (await (await handleApi(new Request(`http://x${devicePath}/config`), state))!.json()) as any : undefined;
  return { status: r.status, state: r.state, body: { ...(view ?? {}), readback: r.result as any, error: r.error } };
}
