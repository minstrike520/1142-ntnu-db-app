# Frontend Client Web App Directory Orientation for AI Agents

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-06-14 -->

## Purpose
This directory contains the Next.js 16 + React 19 client web application. It includes user authentication flows, chat rooms, settings panels, and Socket.IO real-time clients.

## Key Files

| File | Description |
|------|-------------|
| [src/context/ChatContext.tsx](src/context/ChatContext.tsx) | Centralized React Context: Manages connection states, token storage, active chat rooms, messages feed, unread status counts, folders, and typing statuses |
| [src/lib/api.ts](src/lib/api.ts) | HTTP REST API client wrappers. Converts responses into typed models matching `shared/types.ts` |
| [src/lib/socket.ts](src/lib/socket.ts) | Socket.IO Client Wrapper: Sets up callbacks for incoming websocket message updates, typing indicators, and read receipts |
| [src/app/globals.css](src/app/globals.css) | Global stylesheet utilizing Tailwind CSS v4 design tokens and layouts |

## Subdirectories

| Directory | Purpose | Detail Orientation |
|-----------|---------|--------------------|
| [src/app/](src/app/) | Next.js App Router | Contains root layout, auth pages, chat room page, and settings panels |
| [src/components/](src/components/) | Reusable React Components | Subdivided into `chat/` UI panels, `settings/` panels, and `ui/` primitive elements |
| [src/locales/](src/locales/) | Internationalization | JSON key-value translation files for localization (`zh-TW.json`, `en.json`) |

## For AI Agents

### 1. App Router & Rendering Rules
- This project utilizes Next.js App Router under `src/app/`.
- All pages and components are Server Components by default.
- If a component uses state (`useState`), effects (`useEffect`), browser APIs (`localStorage`), or UI context hooks, you **MUST** declare the `"use client"` directive at the very top of the file.

### 2. Centralized State Management
- **DO NOT** instantiate raw API fetch calls or new Socket connections inside individual UI components.
- Always use the state, REST methods, and Socket triggers exposed by the central [ChatContext.tsx](src/context/ChatContext.tsx).

### 3. Localization (i18n) Rules
- **NEVER** hardcode Chinese or English text strings directly in component renders.
- All UI text must be stored in [src/locales/zh-TW.json](src/locales/zh-TW.json) and [src/locales/en.json](src/locales/en.json).
- Use the `useTranslation` hook from `@/hooks/useTranslation` to dynamically retrieve translated text in Client Components (e.g. `{t("sidebar.chats")}`).

### 4. Styling & Typography
- The layout is styled with Tailwind CSS v4 classes.
- Use Geist Sans and Geist Mono configured via CSS variables for typography.
- Refrain from writing custom CSS classes or module styles unless absolutely necessary; use Tailwind utilities instead.

### 5. API Configuration
- Any configuration exposed to the browser must be prefixed with `NEXT_PUBLIC_`.
- Under Docker Compose, `NEXT_PUBLIC_API_URL` should point to `http://localhost:4005` (the host-facing backend port) to enable browser websocket and REST connections.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
