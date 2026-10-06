# VERIFY-07: Was a budget or reimbursement EVER communicated for the Print Production task?

Worker 7 — deep-verification swarm, 2026-10-06. INVESTIGATION ONLY, no code changes.

## Method

Read the full `description` field of all three Task 02 task docs directly from production Firestore via the REST API (public key from `.env.local`), plus a full scan of every string value in each task document (all 36 fields incl. `guidance`, `resources`, `resourceLinks`, `report`, `workflowTitle`) for the terms: budget, cost, money, pay, payment, reimburse, receipt, expense, fund, price, Rs, PKR, rupees. Also checked the public mission page API (`/api/missions/wf_1791096197560_ugmmt1`, HTTP 200).

Docs audited:
- `tasks/L5Kv8tmIsb6yGi44zkyT` — "Executive Document Audit, Verification & Print File Preparation" (Step 1)
- `tasks/UHtT8yldnfIjWFmnnhGM` — "Print Production & Material Procurement" (Step 2)
- `tasks/z20ZnLAPd3q8ZWRPnRVr` — "Assembly, 5-Point Quality Control & Final Delivery" (Step 3)

**Limitation:** `workflows/wf_1791096197560_ugmmt1` returns `403 PERMISSION_DENIED` ("Missing or insufficient permissions") via the public REST key, so the workflow doc's own resources/links/budget fields could not be read directly. The public missions API (`/api/missions/wf_1791096197560_ugmmt1`) was checked as a fallback: it exposes title, description (empty string at workflow level), steps, deadlines — **no workflow-level resources, links, or budget fields**. All instruction text the assignee would have seen lives in the task docs' `description` fields (the `guidance` field is `null` on all three tasks).

## Verbatim money-related quotes (the ONLY matches across all three tasks)

Both matches are in **Step 2: "Print Production & Material Procurement"** (`tasks/UHtT8yldnfIjWFmnnhGM`), `description` field:

1. RESOURCES section:
> "RESOURCES: Finalized digital print files, budget for printing and folders, contact information for local print facilities and stationery suppliers."

2. VERIFICATION section:
> "VERIFICATION: Photographic evidence of the procured print materials (pages and endorsement letters) and the matte-black presentation folders, including close-ups verifying paper GSM and print quality, must be uploaded. Receipt(s) for printing services and folder purchase must also be submitted."

Steps 1 and 3 contain **zero** money-related terms.

## What the instructions say about who pays

Relevant surrounding wording, Step 2, quoted verbatim:

> "WHAT: Procure 5 sets of the 4-Page Executive Meeting Portfolio and 3 standalone copies of the IST Room 204 Institutional Endorsement Letter from an executive digital print facility. Simultaneously, acquire 5 matte-black presentation folders with clear poly sleeves."

> "HOW: 1. Identify and select a reputable executive digital print facility in Islamabad known for high-quality laser printing. 2. Provide the print-ready files (verified in Step 1) to the chosen facility. 3. Clearly communicate the strict print specifications: 100gsm to 120gsm bright-white laser bond paper (98+ GE brightness) and 1200 DPI laser print resolution. Emphasize that 70-80gsm paper is strictly prohibited. 4. Oversee the printing process to ensure color accuracy, crispness, and paper quality. 5. Purchase 5 matte-black presentation folders with clear poly sleeves from a stationery supplier, ensuring they are free from scratches or defects."

## Answers

**(a) Does any task promise a budget or reimbursement? NO.** The single occurrence of the word "budget" is inside the RESOURCES list — "budget for printing and folders" listed as a resource the assignee should have available, alongside print files and supplier contact info. It names no amount, no currency, no source of funds, and nowhere does any task state that SEDS will provide money, that costs will be covered, or that the assignee will be reimbursed. There is no "submit for reimbursement" path — the only finance-adjacent deliverable is the receipts.

**(b) Do the instructions ask for receipts (implying out-of-pocket spend)? YES.** The VERIFICATION section explicitly requires: "Receipt(s) for printing services and folder purchase must also be submitted." Combined with "Identify and select a reputable executive digital print facility in Islamabad" and "Purchase 5 matte-black presentation folders … from a stationery supplier," the instructions plainly assume the assignee pays at the shop and keeps the receipts. Nothing in the task says who hands her the money or how she is paid back.

**(c) Is there any mention of using institutional (Dr. Najam / IST) printers instead of a commercial print shop? NO.** The instructions explicitly direct her to a commercial option: "Identify and select a reputable executive digital print facility in Islamabad known for high-quality laser printing." No mention of IST printers, Dr. Najam's office printers, or any institutional facility appears anywhere in the three task descriptions.

## Bottom line

The task instructions say: go to a commercial print shop in Islamabad, pay for the prints and folders, and submit the receipts. The word "budget" appears exactly once — as an item on a RESOURCES list with no amount, source, or reimbursement mechanism. **No budget or reimbursement was ever communicated to the assignee in the task instructions.** If Maira spent her own money, the instructions neither promised repayment nor told her how to get it back.
