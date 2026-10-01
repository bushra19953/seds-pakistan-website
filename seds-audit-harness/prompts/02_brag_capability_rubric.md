# Prompt 02: BRAG Capability Assessment Rubric

## Objective

The BRAG rubric provides objective criteria to classify every feature in the SEDS website codebase. 
It prevents wishful thinking by tying capability claims to empirical code artifacts.

Every feature receives a score from 0 to 100 and a tier assignment:
- **Tier 1: Production Ready (Score 90-100)**
- **Tier 2: Partial / Work-in-Progress (Score 40-89)**
- **Tier 3: Mock / Stub (Score 0-39)**

---

## The Three Tiers Defined

### Tier 1: Production Ready (Score 90-100)
A feature qualifies for Tier 1 when it satisfies all of these criteria:
1. Connects to live database collections with typed reads and writes.
2. Validates user input through explicit schemas (Zod, Yup) on client and server.
3. Enforces access control through verified security rules and server tokens.
4. Implements user-facing error boundaries and loading indicators.
5. Handles asynchronous network failures without crash states.

### Tier 2: Partial / Work-in-Progress (Score 40-89)
A feature falls into Tier 2 when it has active development with critical gaps:
1. UI components render and accept input, but submit handlers dispatch to mock payloads.
2. Form fields lack server-side validation or sanitize partial inputs without server guards.
3. API endpoints return static mock JSON without querying database tables.
4. Binary upload buttons take files but lack server size caps or storage bucket bindings.
5. Error handling relies on basic `catch(err) { console.error(err) }` without user alerts.

### Tier 3: Mock / Stub (Score 0-39)
A feature falls into Tier 3 when it acts as visual decoration without functional mechanics:
1. Static JSX cards and layout grids hardcoded inside component bodies.
2. Buttons that lack `onClick` handlers or trigger dummy console logs without network calls.
3. Form submission calls `e.preventDefault()` and stops without network requests.
4. Upload dropzones that accept drags without saving bytes to disk or cloud storage.
5. Navigation links that point to `#` or trigger 404 unrouted paths.

---

## Five Evaluation Dimensions

Evaluate every subsystem across these five dimensions:

| Dimension | Tier 1 Standard (18-20 pts) | Tier 2 Standard (8-17 pts) | Tier 3 Standard (0-7 pts) |
| :--- | :--- | :--- | :--- |
| **1. Data Persistence** | Live typed queries to Firestore or SQL tables. Atomic writes. | Reads from local JSON state or writes without schema validation. | Hardcoded arrays in JSX. Zero database imports. |
| **2. Error Resilience** | Error boundaries, toast alerts, network retry logic, clean timeouts. | Generic console error logs. UI hangs or freezes on rejected promises. | Zero error handling. Unhandled exceptions crash the React root. |
| **3. Access Control** | Token verification in middleware plus server-side security rules. | Client-side route hides without server endpoint verification. | Open endpoints or zero role checks. Anyone can read or write. |
| **4. Binary File Intake** | Multi-part stream to cloud buckets, 100MB limit check, MIME validation. | Uploads small files into memory; lacks size limits or bucket storage. | Dummy dropzone UI. Dropping files does nothing. |
| **5. Integration Pipeline** | Verified outbound webhooks or email dispatch via live SDKs. | Stubbed mail functions or unconfigured environment variables. | Missing API keys, dead webhook URLs, or commented SDK calls. |

---

## Code Examples: Side-by-Side Comparison

### Example 1: Hardware Intake Form Submission

#### Tier 1 Implementation (Production Ready)
```typescript
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { intakeSchema, IntakeFormData } from '@/schemas/intake';
import { db } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export function SourcingIntakeForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<IntakeFormData>({
    resolver: zodResolver(intakeSchema)
  });

  const onSubmit = async (data: IntakeFormData) => {
    try {
      setServerError(null);
      await addDoc(collection(db, 'sourcing_inquiries'), {
        ...data,
        status: 'SUBMITTED',
        createdAt: serverTimestamp()
      });
      window.location.href = '/sourcing/confirmation';
    } catch (err) {
      setServerError('Submission failed. Check network connection and retry.');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <input {...register('teamName')} aria-label="University Rocketry Team" />
      {errors.teamName && <p className="text-red-500">{errors.teamName.message}</p>}
      {serverError && <div className="alert-error">{serverError}</div>}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Transmitting CAD Package' : 'Submit RFQ'}
      </button>
    </form>
  );
}
```

#### Tier 2 Implementation (Partial / WIP)
```typescript
import { useState } from 'react';

export function SourcingIntakeForm() {
  const [teamName, setTeamName] = useState('');
  const [status, setStatus] = useState('');

  const handleSend = () => {
    // Missing Zod validation schema
    // Missing server error handling
    setStatus('Submitting request');
    fetch('/api/sourcing', {
      method: 'POST',
      body: JSON.stringify({ teamName })
    })
      .then(res => res.json())
      .then(data => setStatus('Success!'))
      .catch(err => {
        console.error(err);
        setStatus('Error occurred');
      });
  };

  return (
    <div>
      <input value={teamName} onChange={e => setTeamName(e.target.value)} />
      <button onClick={handleSend}>Submit</button>
      <p>{status}</p>
    </div>
  );
}
```

#### Tier 3 Implementation (Mock / Stub)
```typescript
export function SourcingIntakeForm() {
  return (
    <form onSubmit={e => { e.preventDefault(); console.log('Mock intake submitted'); }}>
      <input type="text" aria-label="Project Name" />
      <button type="submit">Submit RFQ</button>
    </form>
  );
}
```

---

### Example 2: CAD / BOM Binary Upload Handler

#### Tier 1 Implementation (Production Ready)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from 'firebase-admin/storage';
import { verifyAuthToken } from '@/lib/auth-admin';

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB limit
const ALLOWED_EXTENSIONS = ['.step', '.stp', '.iges', '.stl', '.dxf', '.zip'];

export async function POST(req: NextRequest) {
  const user = await verifyAuthToken(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get('cadFile') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Payload exceeds 100MB limit' }, { status: 413 });
  }

  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return NextResponse.json({ error: 'Disallowed file extension' }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const bucket = getStorage().bucket();
  const blob = bucket.file(`cad_intake/${user.uid}/${Date.now()}_${file.name}`);

  await blob.save(buffer, { contentType: file.type });
  return NextResponse.json({ success: true, path: blob.name });
}
```

#### Tier 2 Implementation (Partial / WIP)
```typescript
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  // Lacks auth verification
  // Lacks file size cap checks
  // Lacks extension whitelist
  const formData = await req.formData();
  const file = formData.get('file');
  console.log('Received file:', file);
  return NextResponse.json({ status: 'file received in memory' });
}
```

#### Tier 3 Implementation (Mock / Stub)
```typescript
export function DropZone() {
  return (
    <div 
      className="border-dashed border-2 p-10 cursor-pointer"
      onClick={() => alert('CAD intake demonstrator: Drop upload disabled in preview mode')}
    >
      <p>Drop STEP, STL, or IGES assemblies here (Max 100MB)</p>
    </div>
  );
}
```

---

## Agent Assessment Instructions

When scoring subsystems for `CAPABILITIES_BRAG_REPORT.md`, compile this standardized evaluation table for each feature:

```markdown
### Subsystem: [Subsystem Name]
- **Target File**: `[path/to/file.tsx#L10-L80]`
- **Evaluated Score**: `[0-100]`
- **Assigned Tier**: `[Tier 1 | Tier 2 | Tier 3]`

#### Score Breakdown:
- Data Persistence: `[0-20]`
- Error Handling: `[0-20]`
- Access Control: `[0-20]`
- Binary Intake: `[0-20]`
- Integration Pipeline: `[0-20]`

#### Empirical Evidence:
- Verified DB Call: `[cite exact line or "None"]`
- Verified Validation: `[cite Zod schema or "Missing"]`
- Security Rules: `[cite rules path or "Unprotected"]`

#### Remediation Plan:
- Action 1: [Concrete implementation step]
- Action 2: [Concrete implementation step]
```
