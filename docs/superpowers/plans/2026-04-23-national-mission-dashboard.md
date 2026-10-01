# National Mission Dashboard & Premium PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Projects page into a National Mission Board and upgrade PDF exports with professional assignee photos.

**Architecture:** 
- Enhance the `jsPDF` export library to support dynamic image embedding with circular clipping.
- Update the Workflows management UI to pre-process profile images into Base64 format.
- Inject a real-time "National Command" dashboard into the existing Projects hub using Firestore task listeners.

**Tech Stack:** Next.js, Firestore, jsPDF, Tailwind CSS, Lucide Icons.

---

### Task 1: Premium PDF - Assignee Avatars & Circular Clipping

**Files:**
- Modify: `src/lib/workflow-pdf-export.ts`

- [ ] **Step 1: Update WorkflowPDFStep interface**

```typescript
export interface WorkflowPDFStep {
  // ... existing fields
  assigneePhoto?: string; // Base64 data URL
}
```

- [ ] **Step 2: Implement drawCircularImage helper**

```typescript
function drawCircularImage(doc: jsPDF, imgB64: string, x: number, y: number, size: number) {
  try {
    doc.saveGraphicsState();
    doc.beginFormObject(x, y, size, size, [0, 0, 1, 0, 0, 1]);
    doc.circle(size / 2, size / 2, size / 2, 'F');
    doc.clip();
    doc.addImage(imgB64, 'JPEG', 0, 0, size, size);
    doc.endFormObject('circle_img');
    doc.restoreGraphicsState();
    doc.doFormObject('circle_img', [1, 0, 0, 1, x, y]);
  } catch (e) {
    console.warn('Failed to draw circular image', e);
  }
}
```

- [ ] **Step 3: Integrate avatar into the "ASSIGNED TO" block**

Modify the drawing loop to place the avatar next to the name. Adjust `innerY` logic to ensure the avatar fits within the box.

---

### Task 2: Workflows Page - Image Pre-processing

**Files:**
- Modify: `src/app/admin/workflows/page.tsx`

- [ ] **Step 1: Implement urlToBase64 utility**

Add a helper function to fetch a URL and return a Base64 data string.

```typescript
const urlToBase64 = async (url: string): Promise<string> => {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};
```

- [ ] **Step 2: Update handleExportPDF to process photos**

Before calling `exportWorkflowAsPDF`, map over the steps and convert `assigneePhoto` URLs to Base64. Use `Promise.all` for efficiency.

---

### Task 3: National Mission Hub - Projects Page Dashboard

**Files:**
- Modify: `src/app/projects/page.tsx`

- [ ] **Step 1: Add Mission Dashboard Listener**

Create a real-time listener for tasks with `workflowId` to calculate global progress.

```typescript
const [nationalStats, setNationalStats] = useState({
  totalMissions: 0,
  completedSteps: 0,
  totalSteps: 0,
  avgProgress: 0
});

useEffect(() => {
  const q = query(collection(firestore, 'tasks'), where('workflowId', '!=', null));
  return onSnapshot(q, (snap) => {
    const tasks = snap.docs.map(d => d.data());
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    // ... calculate stats
    setNationalStats({ ... });
  });
}, []);
```

- [ ] **Step 2: Render "National Command" Banner**

Add a sleek, high-impact banner component at the top of the `main` section in `src/app/projects/page.tsx`. Use a dark gradient, Pakistan Green borders, and a large progress bar.

---

### Task 4: Deployment & Verification

- [ ] **Step 1: Deploy to Vercel**
Run `vercel --prod`.

- [ ] **Step 2: Manual Verification**
1. Open a mission with an assignee who has a profile photo.
2. Export PDF and verify the photo appears in a clean circle.
3. Open `/projects` and verify the National Mission Dashboard shows live data.
