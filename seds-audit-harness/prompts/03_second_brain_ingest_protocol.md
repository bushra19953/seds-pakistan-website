# Prompt 03: Second Brain Ingestion Protocol

## Objective

This protocol governs the generation of `SEDS_BRAIN_INGESTION_BUNDLE.md`. 
The generated bundle bridges software audit findings into Zubair's TencentDB-Agent-Memory L0-L3 semantic architecture.

The output feeds straight into:
1. `L1_atomic_facts_ledger.md` (Table additions with immutable `node_id` keys)
2. `active_symbolic_sourcing_canvas.mmd` (Mermaid flowcharts connecting web intake to Chinese factory nodes)

The agent must format every entry so Zubair can append the blocks without manual reformatting.

---

## Memory Pyramid Layer Alignment

The bundle organizes audit discoveries across four architectural layers:

```
┌────────────────────────────────────────────────────────┐
│ L3: Strategic Intent & Commercial Arbitrage            │
│ → SEDS Sourcing Bridge connects global teams to China  │
├────────────────────────────────────────────────────────┤
│ L2: Operational Scenarios                              │
│ → Intake submission, CAD verification, quote dispatch  │
├────────────────────────────────────────────────────────┤
│ L1: Immutable Atomic Facts Ledger                      │
│ → Node IDs, database models, verified API routes       │
├────────────────────────────────────────────────────────┤
│ L0: Epistemic Ground Truth & Commit Audit              │
│ → Git commit hashes, audit timestamps, branch origins  │
└────────────────────────────────────────────────────────┘
```

---

## Specification for `SEDS_BRAIN_INGESTION_BUNDLE.md`

The agent must generate `SEDS_BRAIN_INGESTION_BUNDLE.md` inside `./audit_output/` matching the exact schema below:

### Section 1: L0 Epistemic Provenance
Record immutable audit metadata:
- Audit Execution Timestamp (ISO 8601)
- Repository Git Commit SHA
- Target Git Branch
- Auditor Agent Model Identifier
- Working Tree Cleanliness Status

### Section 2: L1 Atomic Fact Ledger Insertions
Format all discovered systems as table rows ready for insertion into `L1_atomic_facts_ledger.md`.

Use this exact column layout:
`| node_id | Entity Name (CN / EN) | Ring / Hub | Subsystem | Key Contact & Title | Verified Phone | Verified WeChat ID | Verified Machinery Bank | Metrology & Certs | Factory Physical Gate Address | Pipeline Status | Evidence / Dossier Path |`

Map software systems into the matrix using these standard node prefixes:
- `SEDS-WEB-PORTAL-L1`: The primary web hosting framework and router
- `SEDS-RBAC-AUTH-L1`: Authentication mechanics, session handling, and access roles
- `SEDS-INTAKE-CAD-L1`: The hardware RFQ intake pipeline and CAD storage bucket
- `SEDS-NOTIFY-DISPATCH-L1`: Outbound notification relays and webhook connectors

#### Example Row Template:
```markdown
| **`SEDS-INTAKE-CAD-L1`** | SEDS Sourcing Bridge Intake System<br/>CAD & Hardware Portal | Digital Intake<br/>(Cloud Infrastructure) | **S1-S6** | Webmaster & Dev Team<br/>SEDS Pakistan Ops | N/A (Web Portal) | N/A (Web Portal) | Cloudflare R2 / Firebase Storage Bucket (`seds-cad-vault`), 100MB limit check | Client-side Zod validation, SHA-256 binary hashing | Cloud Hosted Infrastructure | 🟢 **AUDITED GROUND TRUTH**<br/>(Sep 26, 2026) | `audit_output/CAPABILITIES_BRAG_REPORT.md` |
```

### Section 3: L2 Operational Scenarios
Define the three operational flows supported by the website code:

1. **Scenario 1: Hardware RFQ & CAD Ingestion Flow**
   Trace the exact path when an overseas student rocketry team submits a STEP model file.
   - Client form submission
   - Binary storage upload
   - Database record creation
   - Admin alert trigger

2. **Scenario 2: Admin Access & Triage Workflow**
   Trace how an administrator reviews submissions.
   - Admin login and claim check
   - Dashboard table query
   - File download URL generation
   - Status update mutation (`PENDING` to `REVIEWED`)

3. **Scenario 3: China Supplier Dispatch Route**
   Trace how reviewed requirements bridge to Chinese aerospace manufacturing partners.
   - Exporting technical specs (material, tolerance, quantity)
   - Transmitting requirements to Ring 1 Shanghai or Ring 5 Shenzhen suppliers
   - Tracking RFQ turnaround time

### Section 4: L3 Strategic Alignment & Arbitrage Leverage
Document how current website code supports the commercial mission:
- Cost arbitrage (50% to 70% reduction in prototype machining costs)
- Cycle time compression (cutting 12-week local wait times to 7 days)
- Academic and institutional validation for SEDS Pakistan

---

## Symbolic Canvas Integration Specification

The agent must output a valid Mermaid diagram segment for insertion into `active_symbolic_sourcing_canvas.mmd`.

### Node Connection Rules:
1. Wrap all web portal nodes in a distinct subgraph: `subgraph SEDS_Web_Bridge["🛰️ SEDS Pakistan Web Portal & Digital Intake System"]`.
2. Connect web intake nodes to the six astronautics subsystems (`S1` to `S6`).
3. Connect verified intake pipelines to supplier nodes in Ring 1 (Shanghai Chijiang `CJPM`, Shanghai Yunzhu `YZ`) and Ring 5 (Shenzhen Sendot `SENDOT`, Shenzhen ILINKGLOBE `ILINK`).

### Canvas Code Format:
```mermaid
    %% SEDS DIGITAL INTAKE & WEB PORTAL INTEGRATION
    subgraph SEDS_Web_Bridge["🛰️ SEDS Pakistan Web Portal & Digital Intake System"]
        WEB_CORE["[node_id: SEDS-WEB-PORTAL-L1]<br/><b>SEDS Official Web Core</b><br/>Framework: Next.js App Router<br/>Status: 🟢 AUDITED GROUND TRUTH<br/>Path: audit_output/"]
        
        WEB_AUTH["[node_id: SEDS-RBAC-AUTH-L1]<br/><b>Auth & Role Access Control</b><br/>Provider: Firebase Auth & Claims<br/>Status: 🟢 AUDITED GROUND TRUTH<br/>Path: audit_output/"]
        
        WEB_INTAKE["[node_id: SEDS-INTAKE-CAD-L1]<br/><b>Sourcing Bridge CAD Intake</b><br/>Storage: Cloud Bucket (100MB Cap)<br/>Status: 🟡 PARTIAL / WORK IN PROGRESS<br/>Path: audit_output/"]
        
        WEB_NOTIFY["[node_id: SEDS-NOTIFY-DISPATCH-L1]<br/><b>Notification & Webhook Relay</b><br/>Channel: Email & Telegram Bot<br/>Status: 🔴 MOCK / UNCONFIGURED<br/>Path: audit_output/"]
    end

    %% Web Intake Links to Astronautics Subsystems
    WEB_INTAKE --> S1
    WEB_INTAKE --> S2
    WEB_INTAKE --> S3
    WEB_INTAKE --> S4
    WEB_INTAKE --> S5
    WEB_INTAKE --> S6

    %% Subsystem Routing to Chinese Factory Partners
    WEB_INTAKE -.->|Structures RFQ| CJPM
    WEB_INTAKE -.->|Precision CNC| SENDOT
    WEB_INTAKE -.->|Metal 3D Printing| YZ
    WEB_INTAKE -.->|Avionics PCBA| ILINK
```

---

## Execution Verification Checklist

Before finalizing `SEDS_BRAIN_INGESTION_BUNDLE.md`, verify:
- Every `node_id` follows standard kebab-case uppercase notation ending in `-L1`.
- Table columns in Section 2 match `L1_atomic_facts_ledger.md` character for character.
- Mermaid syntax compiles without errors. Node names contain no unescaped brackets or invalid punctuation.
- Citations reference verified files in `audit_output/`.
