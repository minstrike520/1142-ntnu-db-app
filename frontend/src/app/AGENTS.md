<!-- Parent: ../../AGENTS.md -->
<!-- Updated: 2026-06-01 -->

# src/app

## Purpose
Next.js App Router directory for the implemented frontend. It contains public auth routes plus the authenticated main app shell, chat route, and settings route.

## Key Files

| File | Description |
|------|-------------|
| `layout.tsx` | Root layout and global CSS import |
| `globals.css` | Tailwind CSS v4 setup and custom design tokens |
| `login/page.tsx` | Login form |
| `register/page.tsx` | Registration form |
| `(main)/layout.tsx` | Authenticated layout with sidebar |
| `(main)/page.tsx` | Main route redirect/entry behavior |
| `(main)/chat/[chatId]/page.tsx` | Chat room page |
| `(main)/settings/page.tsx` | Personal settings page |

## For AI Agents

### Working In This Directory
- Add `"use client"` to route components that use hooks, context, localStorage, Socket.IO, or browser APIs.
- New authenticated routes should generally live under `(main)/` so they share the sidebar layout.
- Import shared frontend state through `@/context/ChatContext` where appropriate.
- Use UI primitives from `@/components/ui/*` rather than duplicating button/input/modal styling.

### Testing Requirements
- For Docker Compose, verify browser behavior at `http://localhost:3005`.
- For local non-Docker `pnpm dev`, the Next.js dev server still listens on its configured local port.

### Common Patterns
- Import path alias `@/` maps to `frontend/src`.
- Custom color classes such as `bg-surface-card`, `border-border-primary`, `text-text-muted`, and `text-primary` come from `globals.css`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
