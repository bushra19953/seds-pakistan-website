# v18.0 SWARM DEPLOYED — STAGE 8/14 STARTING
# STAGE 8: AI-TASK-GENERATION FORENSICS (PROMPT LEAK & COST AUDIT)

## 1. Agent Swarm Analysis: The "AI & Security" Layer (COT)

### Agent 02 (UX/UI Auditor):
> "The 'Brain Dump' feature is a 'UX Masterclass', but the implementation is 'Architectural Anarchy'. We have a secure server-side proxy (`api/ai-task-generator`) that is being completely ignored by the `TaskForm` component. This forced users to provide their own API keys—a massive barrier to entry for non-technical admins."

### Agent 09 (Performance Engineer):
> "From a cost perspective, we are 'Blindfolded'. By allowing direct client-side calls to Google, we lose all observability. We can't see how many tokens are being consumed across the organization, we can't implement rate limits, and we can't cache common task generation requests. This is a budget leak waiting to happen."

---

## 2. Prompt Leakage Analysis
The `TaskForm` (Lines 1050-1120) constructs a massive prompt containing:
- Full `USER_ROLES` enumeration.
- Full `ROLE_HIERARCHY` map.
- Full `RoleDefinitions` from Firestore.
- A list of all users in the chapter (including UIDs and display names).

**Risk:** Any user with access to the Admin Dashboard can inspect the network tab and extract the entire organizational structure and internal capability mapping by simply clicking 'Generate with AI'.

---

## 3. The "Shadow AI" Security Gap

| Feature | Secure Proxy (`/api/ai-task-generator`) | Current Client-Side (`TaskForm`) | Status |
| :--- | :---: | :---: | :--- |
| **API Key Storage** | Secure (ENV Variable) | Insecure (LocalStorage) | ❌ **FAIL** |
| **Prompt Logic** | Hidden (Server-Side) | Exposed (Client-Side) | ❌ **FAIL** |
| **Rate Limiting** | Possible | Impossible | ❌ **FAIL** |
| **Safety Filters** | Enforced | Optional | ⚠️ **Risk** |
| **Cost Control** | Centralized | Fragmented | ❌ **FAIL** |

---

## 4. Technical Cost Forensics (Estimated)
- **Model:** `gemini-1.5-flash` (~$0.075 / 1M input tokens).
- **Average Prompt Size:** 3,500 tokens (due to the large user list and role context).
- **Average Output Size:** 800 tokens.
- **Cost per Task Generation:** ~$0.0004.
- **Leakage Risk:** While the cost per call is low, the *data* being leaked (user lists, role capabilities) is worth significantly more than the token cost.

---

## 5. Strategy for Optimization (Stage 8 Verdict)
1. **Force Proxy Adoption:** Refactor `TaskForm` to ONLY use the `/api/ai-task-generator` endpoint.
2. **Remove API Key Input:** Eradicate the "Enter Gemini Key" UI from the frontend.
3. **Context Trimming:** Instead of sending *all* users to the AI, send only a summarized count of roles or a small subset of "Active & Available" users to reduce token costs and data exposure.
4. **Result Caching:** Implement a simple Redis or in-memory cache for common "Brain Dump" patterns to avoid redundant AI calls.

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
