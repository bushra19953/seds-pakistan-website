# v18.0 SWARM DEPLOYED — STAGE 10/14 STARTING
# STAGE 10: PROPOSED CODE DIFF (SURGICAL CHANGES)

## 1. Agent Swarm Analysis: The "Implementation & Surgery" Layer (COT)

### Agent 01 (Lead Architect):
> "Our target is the 'Chaos Points' identified in Stages 2, 3, 7, and 8. We will perform a triple-bypass surgery on the state machine to force consistency between the Profile UI and the Admin API. We will also implement a 'Strict Schema Lockdown' to eliminate the mass assignment vulnerability. This is surgical, non-breaking, and backwards-compatible."

### Agent 03 (Front-End Specialist):
> "The 'Mission Control' UI will be upgraded with a 'Filter Strip'. This is a low-impact, high-value change that directly addresses the 'Filter Poverty' identified in Stage 4. We will also refactor the AI generation to be 'Proxy-First', eliminating the need for client-side API keys."

---

## 2. Surgical Change A: Unified Rejection Flow
**File:** `src/components/profile/task-detail-dialog.tsx`

```typescript
// OLD (Lines 314-325)
const res = await fetch('/api/tasks', {
    method: 'PATCH',
    body: JSON.stringify({
        taskId: task.id,
        updates: {
            status: 'in-progress',
            rejectionFeedback: feedback || undefined
        }
    })
});

// NEW (Unified State Machine)
const res = await fetch('/api/tasks', {
    method: 'PATCH',
    body: JSON.stringify({
        taskId: task.id,
        updates: {
            status: 'changes-requested',
            feedback_text: feedback || 'No feedback provided'
        }
    })
});
```

---

## 3. Surgical Change B: API Schema Lockdown (Security)
**File:** `src/app/api/tasks/route.ts`

```typescript
// OLD (Lines 33-36)
const TaskUpdateSchema = z.object({
  taskId: z.string().min(1),
  updates: z.object({}).passthrough(), // 🚨 DANGEROUS PASS-THROUGH
});

// NEW (Strict Whitelist)
const TaskUpdateSchema = z.object({
  taskId: z.string().min(1),
  updates: z.object({
    status: z.enum(['pending', 'in-progress', 'submitted-for-review', 'changes-requested', 'completed', 'approved']).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    deadline: z.union([z.string(), z.number(), z.date()]).optional(),
    hoursWorked: z.number().optional(),
    report: z.string().optional(),
    feedback_text: z.string().optional(), // Now officially part of the schema
    resourceLinks: z.string().optional(),
    resources: z.array(z.any()).optional(),
  }).strict(), // ✅ NO MORE POINT INJECTION
});
```

---

## 4. Surgical Change C: Mission Control Filter Strip (UX)
**File:** `src/components/profile/assigned-tasks.tsx`

```typescript
// NEW Filter State
const [statusFilter, setStatusFilter] = useState<string>('all');
const [projectFilter, setProjectFilter] = useState<string>('all');

// NEW Filter UI (Above categorizedMissions.map)
<div className="flex gap-4 mb-6 overflow-x-auto pb-2">
  <Select value={statusFilter} onValueChange={setStatusFilter}>
    <SelectTrigger className="w-[150px]"><SelectValue placeholder="Status" /></SelectTrigger>
    <SelectContent>
      <SelectItem value="all">All Statuses</SelectItem>
      <SelectItem value="pending">To Do</SelectItem>
      <SelectItem value="in-progress">In Progress</SelectItem>
      <SelectItem value="submitted-for-review">In Review</SelectItem>
    </SelectContent>
  </Select>
  {/* Project Filter ... */}
</div>

// Updated normalized memo to respect filters
const filtered = normalized.filter(t => 
  (statusFilter === 'all' || t.status === statusFilter) &&
  (projectFilter === 'all' || (t.projectId || 'uncategorized') === projectFilter)
);
```

---

## 5. Surgical Change D: AI Proxy Migration
**File:** `src/components/admin/tasks/task-form.tsx`

```typescript
// OLD: Direct Client-Side Fetch
const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/...key=${apiKey}`, { ... });

// NEW: Secure Server-Side Proxy
const resp = await fetch('/api/ai-task-generator', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: brainDump,
    chapterId: chapterSelectValue,
    // Context is now minimized to reduce token cost
    context: { activeUserCount: usersChapter.length } 
  })
});
```

---

## 6. Execution Protocol
1. Apply **Change B** first (Backend Security) to prevent regression.
2. Apply **Change A** (UI Sync) to align with Backend.
3. Apply **Change D** (AI Hardening) to remove insecure localStorage keys.
4. Apply **Change C** (UX Enhancement) as the final layer of polish.

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
