/**
 * Decision-class matrix reader (ws-a §3.9; Meetings Core contract §6) — server only.
 *
 * The matrix (`decisionClasses` collection, loaded from Doc 04 Article 5) is a
 * Phase 2 substrate. This workstream CONSUMES it: threshold copy at motion /
 * circular creation, the Reserved Matter flag (urgent-decision hard block),
 * the filing flag, the assigned-body check, and the enforcementMode flag
 * (warn-only vs enforce, respected at motion open per ws-a §4.5). It never
 * writes a class.
 *
 * ADAPTER (local matrix): until the Phase 2 collection exists, the default
 * reader is backed by the single spec-derived local matrix in
 * src/lib/governance/circular/threshold.ts (LOCAL_DECISION_CLASS_MATRIX).
 * That table is the ONE local stand-in for the whole workstream; when the
 * Firestore collection lands, `localMatrixDecisionClassesReader` is replaced
 * by a Firestore reader and the local table is deleted, not kept as a second
 * matrix.
 */

import {
  LOCAL_DECISION_CLASS_MATRIX,
  resolveDecisionClass,
} from "@/lib/governance/circular/threshold";
import type { DecisionClassView } from "@/lib/governance/circular/types";

export type EnforcementMode = "warn-only" | "enforce";

/** The class view as consumed server-side: the §3.9 fields plus the mode flag. */
export interface ServerDecisionClassView extends DecisionClassView {
  enforcementMode: EnforcementMode;
}

export interface DecisionClassesReader {
  getClass(classId: string): Promise<ServerDecisionClassView | null>;
  listClasses(): Promise<ServerDecisionClassView[]>;
}

/** In-memory reader for local tests; classes are injected by the caller. */
export class InMemoryDecisionClassesReader implements DecisionClassesReader {
  constructor(private classes: ServerDecisionClassView[] = []) {}

  add(cls: ServerDecisionClassView): void {
    this.classes.push(cls);
  }

  async getClass(classId: string): Promise<ServerDecisionClassView | null> {
    return this.classes.find((c) => c.id === classId) ?? null;
  }

  async listClasses(): Promise<ServerDecisionClassView[]> {
    return [...this.classes];
  }
}

/**
 * ADAPTER: reader over the spec-derived local matrix. enforcementMode
 * defaults to "warn-only" for every local class (gate Z-19: the matrix is
 * not signed off for enforcement until Zubair approves it).
 */
export function localMatrixDecisionClassesReader(
  enforcementMode: EnforcementMode = "warn-only",
): DecisionClassesReader {
  return {
    async getClass(classId: string) {
      const cls = resolveDecisionClass(classId);
      return cls ? { ...cls, enforcementMode } : null;
    },
    async listClasses() {
      return LOCAL_DECISION_CLASS_MATRIX.map((cls) => ({ ...cls, enforcementMode }));
    },
  };
}
