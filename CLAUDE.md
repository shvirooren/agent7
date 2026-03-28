# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agent 7** is a Hebrew-language (RTL) real-time task management and AI assistant SaaS platform for the Israeli market. It is a **static, no-build-step application** — all code is vanilla JavaScript, CSS, and HTML with no package manager, bundler, or framework.

Backend is entirely **Supabase** (PostgreSQL + Auth + Realtime subscriptions). Deploy by uploading HTML files to any static host (currently Cloudflare Pages at `agent7.pages.dev`).

## Development

**No build step.** Open any `.html` file directly in a browser or serve with a simple HTTP server:
```bash
npx serve .
# or
python -m http.server 8080
```

There are no tests, linters, or CI pipelines configured.

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Marketing landing page |
| `login.html` | Auth entry point — detects role, routes to dashboard or employee portal |
| `dashboard.html` | Manager/admin portal (~10k+ lines of embedded JS) |
| `employee.html` | Employee task portal |
| `set-password.html` | Password reset flow (linked from Supabase email) |
| `employee-login.html` | Redirect shim → `login.html` |

## Architecture

### Authentication & Routing
- Supabase email/password auth with JWT sessions
- After login, `user_roles` table determines role (`manager` vs `employee`)
- Managers → `dashboard.html`, employees → `employee.html`
- `set-password.html` handles Supabase recovery session before redirecting to correct portal

### Supabase Integration
Credentials are embedded directly in each HTML file (anon/public key — safe for client-side). The key tables are:
- `user_roles` — auth user → role mapping
- `companies` — company records (linked to manager via `manager_id`)
- `employees` — employee records with department/role
- `employee_users` — links Supabase auth users to employee records
- `tasks` — task data (title, status, priority, `employee_id`, file attachments)
- `files` — task file attachments (stored URL + metadata)
- `shipments` — shipment tracking records

Realtime updates use Supabase `postgres_changes` subscriptions — employees receive live task updates filtered by `employee_id=eq.{id}`.

### Manager Dashboard (`dashboard.html`)
The largest file. Sections are toggled via sidebar navigation — only one section is shown at a time (CSS `display` switching). Key sections:
- **Tasks** — create/view/filter tasks; list and kanban views with drag-and-drop
- **Employees** — add employees, send invites, view per-employee task counts
- **Shipments** — manual entry or email-paste parsing (FedEx/UPS/K&N auto-extraction)
- **Agent 7 Chat** — general AI assistant with company knowledge base upload and email-to-tasks parsing
- **Billing** — placeholder section

### Employee Portal (`employee.html`)
Simpler read/update interface. Employees can view their tasks, change status (Open → In Progress → Done), and download attachments. Uses skeleton loading and toast notifications.

## UI Conventions

- **RTL Hebrew-first**: `direction: rtl` on `body`; all user-visible text is Hebrew
- **CSS variables** for the design system (defined inline in each file):
  - Blues: `--bd` (#003366), `--bm` (#0055A4), `--ba` (#009FE3)
  - States: `--gr` green, `--or` orange, `--rd` red
  - Background: `--gl` (#F5F7FA)
- **Responsive breakpoints**: 900px, 768px, 700px, 600px
- **No shared CSS file** — styles are duplicated/embedded per page
- Toast notification pattern and skeleton loading are implemented inline in each file that uses them

## Key Patterns

- All JS is inline `<script>` at the bottom of each HTML file — no modules or imports
- Supabase client is initialized per-page with `createClient(SUPABASE_URL, SUPABASE_KEY)`
- Optimistic UI updates: update the DOM immediately, then persist to Supabase
- Debounce guards on status-change buttons to prevent double-submission
- Agent 7 Chat calls an external Cloudflare Worker API (`agent7-ai.shvirooren.workers.dev`)
