export const SOP_TEMPLATE_PROMPT = `
### FINAL OUTPUT BLUEPRINT: THE SOP TEMPLATE

When the sequence completes and you are commanded to deliver the final map via the \`extracted_document\` JSON field, you MUST strictly format the raw markdown string according to the structural skeleton below.

You are formatting an elite corporate Operating Manual. It must be brutally precise, highly scannable, and devoid of conversational filler. Ensure that IF/THEN logic is visually prominent. Replace the {Bracketed} placeholders with the elevated data you extracted.

--- START BLUEPRINT ---
# SOP: {Insert Clean Title based on Task Name}

> **Voltage Level:** {Insert estimated cognitive load needed 1-10} | **Execution Time Estimate:** {Insert Estimated Time}

## PHASE 1: THE MISSION
**1.1 Strategic Objective**
- {Insert single clear objective statement. What does "done" look like?}

**1.2 Operational Context**
- {Why this task exists / trigger conditions}

**1.3 Definition of Done**
- > *Success is achieved when exactly:* {Insert measurable condition}

## PHASE 2: LOGISTICS & REQUIREMENTS
| Component | Designation |
| :--- | :--- |
| **Actors (Execution)** | {Insert Who does the work} |
| **Decision Authority** | {Insert Who approves} |
| **Timeline Boundaries** | {Insert hard deadlines or schedules} |
| **Domain & Tools** | {Insert systems / platforms needed} |

**2.1 Pre-Execution Checklist (Resources)**
- [ ] {Checklist item of what must be gathered prior to execution}
- [ ] {Checklist item}

## PHASE 3: EXECUTION LOGIC
**Operating Constraints (Non-Negotiables):**
> * {Hard rule 1}
> * {Hard rule 2}

**Step-by-Step Sequence:**
1. **[Atomic Action]** — {Detailed context for step 1}
2. **[Atomic Action]** — {Detailed context for step 2}
3. **[Atomic Action]** — {Detailed context for step 3}

## PHASE 4: FRICTION & FAILSAFES
**Known Vulnerabilities:**
- ⚠️ **[Risk 1]:** {What could go wrong}
  - *Contingency:* {How to bypass or fix it}
- ⚠️ **[Risk 2]:** {What could go wrong}
  - *Contingency:* {How to bypass or fix it}

**Current Active Blockers:**
*(If the user stated a blocker that prevents this SOP from being used immediately, list it here. Otherwise output "None.")*

## PHASE 5: REVIEW & LIFECYCLE
**5.1 Verification Loop**
- {How do we know we remain on track mid-execution?}

**5.2 Post-Mortem Criteria**
- {How do we evaluate its success afterwards?}

**5.3 System Home**
- {Where does this documentation natively live, and who needs access?}

**5.4 Immediate Next Action**
- ⚡ **Next Step:** {The single atomic action the user states must happen in the next 5 minutes after saving this SOP}

--- END BLUEPRINT ---
`;
