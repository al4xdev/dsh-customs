# Plan workflow test

## Goal
Test the plan viewer and owner-review workflow in the updated TUI.

## Scope
- This is a separate test artifact.
- Do not edit code, install packages or modify other plans.
- Approval authorizes only checking and closing this test.

## Review checklist
- Open the rendered plan and navigate with the mouse and arrow keys.
- Press c to add a comment, then Esc to save and return.
- Press c on the same annotated line to edit the existing comment without duplicating it.
- If rejected, submit a new revision using the same plan ID.

## After approval
1. Read the exact approved revision.
2. Ask the owner whether the tested interactions worked.
3. Close only this test plan after owner confirmation, recording any remaining issues.
