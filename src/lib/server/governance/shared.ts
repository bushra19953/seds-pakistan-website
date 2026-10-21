/**
 * Shared consumed-interface seams for the Phase 3 Decisions services
 * (ws-a §3.1, §3.9; Meetings Core contract §6) — server only.
 *
 * Bodies are OWNED by the Meetings Core crew (src/lib/server/governance/
 * bodies.ts in their contract) and filing tasks ride the existing tasks
 * collection. Both are consumed here through narrow interfaces so the
 * Decisions services never fork them:
 *
 * ADAPTER (bodies): `BodyReader` is the read contract. Core's bodies
 * service satisfies it directly; `InMemoryBodyReader` is the test double.
 *
 * ADAPTER (filing tasks): `FilingTaskCreator` creates a task in the
 * existing tasks collection with the field shape of
 * src/app/api/tasks/route.ts (ws-a §3.9): assignee is the secretary,
 * deadline is decidedAt + 30 days (Doc 04 sec 1.7). The Firestore
 * implementation lives in firestore-stores.ts; `InMemoryFilingTaskCreator`
 * records calls for tests.
 */

/** Read view of a bodies doc (ws-a §3.1 read contract). */
export interface BodyView {
  id: string;
  name: string;
  type: string;
  chairUid: string;
  secretaryUid: string;
  memberUids: string[];
  quorumOverride: number | null;
  chapterId: string | null;
}

export interface BodyReader {
  getBody(bodyId: string): Promise<BodyView | null>;
}

/** In-memory BodyReader for local tests. */
export class InMemoryBodyReader implements BodyReader {
  constructor(private bodies: BodyView[] = []) {}

  add(body: BodyView): void {
    this.bodies.push(body);
  }

  async getBody(bodyId: string): Promise<BodyView | null> {
    return this.bodies.find((b) => b.id === bodyId) ?? null;
  }
}

export interface FilingTaskInput {
  title: string;
  description: string;
  /** The secretary of the deciding body (ws-a §3.9). */
  assigneeUid: string;
  /** decidedAt + 30 days (Doc 04 sec 1.7), computed by the caller. */
  deadline: Date;
  sourceKind: "circular" | "motion" | "urgent";
  sourceId: string;
}

export interface FilingTaskCreator {
  createFilingTask(input: FilingTaskInput): Promise<string>;
}

/** In-memory FilingTaskCreator for local tests; records every call. */
export class InMemoryFilingTaskCreator implements FilingTaskCreator {
  readonly created: FilingTaskInput[] = [];
  private seq = 0;

  async createFilingTask(input: FilingTaskInput): Promise<string> {
    this.created.push(input);
    return `filing_task_${++this.seq}`;
  }
}

/** Filing deadline: decidedAt + 30 days (Doc 04 sec 1.7). */
export function filingDeadlineFor(decidedAt: Date): Date {
  return new Date(decidedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
}

/** Base error for the Decisions services: stable code + HTTP status. */
export class GovernanceServiceError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GovernanceServiceError";
  }
}

/**
 * Retention for governance register entries: 10 years from the decision,
 * matching the signed-minutes retention (ws-a §3.7). Decisions and
 * minutes are legal records; nothing in this workstream sets a shorter
 * retention on a register entry.
 */
export function recordRetentionUntil(from: Date): Date {
  const d = new Date(from.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + 10);
  return d;
}
