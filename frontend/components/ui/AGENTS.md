<!-- Parent: ../AGENTS.md -->
<!-- Updated: 2026-06-01 -->

# ui

## Purpose
This top-level `frontend/components/ui/` directory is legacy metadata only. Implemented UI primitives live under `frontend/src/components/ui/`.

## Implemented UI Primitives

| File | Purpose |
|------|---------|
| `frontend/src/components/ui/Avatar.tsx` | User avatar with fallback and online state |
| `frontend/src/components/ui/Badge.tsx` | Small labels and status chips |
| `frontend/src/components/ui/Button.tsx` | Shared button variants |
| `frontend/src/components/ui/ChatBubble.tsx` | Message bubble rendering |
| `frontend/src/components/ui/Checkbox.tsx` | Checkbox with label/description support |
| `frontend/src/components/ui/Dropdown.tsx` | Dropdown/context menu helper |
| `frontend/src/components/ui/Input.tsx` | Shared input wrapper |
| `frontend/src/components/ui/Modal.tsx` | Modal dialog wrapper |

## For AI Agents

- Do not add production UI files here.
- Modify `frontend/src/components/ui/` for real UI work.
- Keep imports using `@/components/ui/*`.
- Preserve existing design tokens from `frontend/src/app/globals.css`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
