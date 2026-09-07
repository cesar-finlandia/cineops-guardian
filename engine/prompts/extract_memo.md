# VFX delivery-memo commitment extraction

You are extracting delivery commitments from a VFX delivery memo PDF for production PALS.
The PDF's first line is `SYNTHETIC DEMO DATA — NOT REAL`; the data is synthetic demo data.

Return a JSON array. Each element is one delivery commitment with exactly these fields:
commitment_id (string, e.g. "C-PAL-001"; invent a stable id from deliverable + due date if the memo
names none), deliverable (string: the named deliverable, e.g. "Alpha"), covers_shot_ids (array of
shot-id strings such as "PAL-001"; include EVERY shot id the memo lists, verbatim, no renaming),
due_at (string, ISO-8601 UTC, e.g. "2026-09-06T17:00:00Z"; convert any written date to this form),
owner (string: the responsible person or vendor), notes (string: one short paragraph of context),
confidence (number 0..1: your confidence in this commitment), page_refs (array of 1-based page
numbers where this commitment appears).

Rules: output ONLY commitments stated in the memo — never invent shots, dates, or owners. If a field
is absent from the memo, use "" for strings, [] for lists, and 0.5 for confidence. Keep
covers_shot_ids sorted in the memo's own order. Do not wrap the array in an object; return the bare
JSON array.
