# Task Containers — Design Spec

**Date:** 2026-06-21
**Feature:** Make the "Containers" feature in the subject-teacher **Tasks → Questions** tab real. Containers are currently hardcoded mock folders (`c1`–`c13`) in `TasksTab.tsx`; this spec replaces them with a real, persisted, division-scoped grouping for AI-generated questions.

## Goal

A subject teacher can create per-topic/chapter **containers** inside a division, generate AI questions into a specific container, and have each question live in exactly one container (its home folder). Deleting a container deletes the questions inside it.

## Context & Current State

- **Frontend:** `qubeex-web/app/teacher/classes/[divisionId]/TasksTab.tsx` (~2,808 lines). The Questions sub-tab shows a folder grid of containers; opening one reveals questions. The container array is hardcoded local state (`c1`–`c13`). The create/rename/delete container UI and folder open/close animations already exist visually but are not wired to any backend. `fetchQuestions` filters only by `divisionId` + `status`, never by container, so every container shows the same flat list. The generate panel only appears when a container is selected (`generateOpen && subTab === 'questions' && selectedContainerId`).
- **Backend:** `backend/src/modules/teacher/tasks.controller.ts` + `teacher.routes.ts`. Questions (`TaskQuestion`) are scoped by `(teacherId, subjectId)` — there is **no `divisionId`** on the question. The frontend passes `divisionId`, which the backend resolves to a subject via `resolveSubjectAssignment(teacherId, divisionId, institutionId)`. So the question pool is currently shared across every division where a teacher teaches the same subject.
- **Modules** (`TaskModule`, the separate "Modules" tab) already provide a many-to-many test-assembly grouping. Containers are a **different** concept (a one-home topic folder) and stay separate from modules.

## Decisions (locked)

1. **Container = home folder.** Each question belongs to exactly one container, chosen at generation time (open container → upload PDF → questions land inside).
2. **Scope = (teacher, subject, division).** Containers are division-specific. The same teacher teaching the same subject in two divisions gets two independent container lists. A question's division is derived through its container (Approach A — normalized; division lives only on the container).
3. **Delete = cascade.** Deleting a container permanently deletes every question inside it, behind a confirmation that shows the count. Questions removed this way also disappear from any Test paper that referenced them (existing `TaskTestQuestion` cascade).
4. **Existing data = wipe.** Current `TaskQuestion`/module/test data is dev-only and will be cleared so `containerId` can be a required column. No data-migration logic.
5. **Modules stay separate.** No change to the Modules feature.

## Out of Scope (YAGNI for v1)

- Moving/reassigning a question between containers.
- A container `description` field.
- Nested / sub-containers.
- Any change to Modules, Tests, Assignments, or the quiz flow beyond the incidental cascade when a container's questions are deleted.

Containers have only a **name**.

## Architecture

### Approach A (chosen)

`TaskContainer` carries `divisionId`; `TaskQuestion` gains a required `containerId` FK and nothing else. A question's division is obtained by joining through its container. Division lives in exactly one place and cannot drift out of sync. Queries always follow the pattern *open a container → list its questions*, so a raw "all questions in a division" query is never needed.

Rejected alternatives:
- **Denormalize `divisionId` onto `TaskQuestion`** — two sources of truth for division, must be kept consistent on every write. Not needed given the access pattern.
- **Reuse `TaskModule` as the container** — modules are many-to-many test-assembly buckets that Tests depend on; conflating them with one-home topic folders tangles both features.

## Data Model

### New model: `TaskContainer`

```prisma
model TaskContainer {
  id            String      @id @default(uuid())
  institutionId String
  institution   Institution @relation(fields: [institutionId], references: [id])
  teacherId     String
  teacher       Teacher     @relation(fields: [teacherId], references: [id])
  subjectId     String
  subject       Subject     @relation(fields: [subjectId], references: [id])
  divisionId    String
  division      Division    @relation(fields: [divisionId], references: [id])

  name          String
  questions     TaskQuestion[]

  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@index([teacherId, subjectId, divisionId])
  @@index([institutionId])
}
```

### `TaskQuestion` — add required home

```prisma
  containerId String
  container   TaskContainer @relation(fields: [containerId], references: [id], onDelete: Cascade)
```

### `TaskPdfUpload` — add container target

```prisma
  containerId String
```

So the background worker knows which container to stamp generated questions with. (Kept as a plain column consistent with the existing `divisionId` column on this model; a relation is optional and not required for v1.)

### Back-relations

Add `taskContainers TaskContainer[]` to `Institution`, `Teacher`, `Subject`, and `Division`.

### Migration steps

Adding a required `containerId` to a populated table fails, so:

1. Delete all `TaskQuestion` rows (their `TaskModuleQuestion` / `TaskTestQuestion` / `TaskStudentAnswer` links cascade away). Wiping `TaskPdfUpload` rows too is fine since they're transient.
2. `pnpm prisma db push` (dev) to apply the new model + columns.
3. `pnpm prisma generate`.

## Backend Endpoints

All under the existing teacher-auth middleware stack (`...T`) in `teacher.routes.ts`, following the style of the existing `/tasks/modules` routes. All queries scoped by `institutionId` + `teacherId` (multi-tenancy).

### New — Container CRUD

| Method | Route | Body / Query | Behavior |
|---|---|---|---|
| `GET` | `/teacher/tasks/containers?divisionId=` | `divisionId` query (required) | Resolve subject via `resolveSubjectAssignment`. Return containers for `(teacherId, subjectId, divisionId, institutionId)`, ordered `createdAt desc`, each with a `questionCount` (`_count.questions`). |
| `POST` | `/teacher/tasks/containers` | `{ divisionId, name }` | Resolve subject. Create container scoped to `(teacherId, subjectId, divisionId, institutionId)`. Return the created container with `questionCount: 0`. |
| `PATCH` | `/teacher/tasks/containers/:id` | `{ name }` | Verify ownership (`id, teacherId, institutionId`). Rename. Return updated container. |
| `DELETE` | `/teacher/tasks/containers/:id` | — | Verify ownership. Delete (cascade removes its questions). Return `{ success: true }`. |

Validation via Zod in `tasks.schema.ts`: `createContainerSchema` (`divisionId: uuid`, `name: string 1–100 trimmed`), `renameContainerSchema` (`name: string 1–100 trimmed`).

### Changed endpoints

**`GET /teacher/tasks/questions`** — switch the primary filter from `divisionId` to **`containerId`** (query param, required). Verify the container belongs to the teacher, then return its questions (keep the existing `status` filter and `moduleAssignment` include). This is called when a container is opened.

**`POST /teacher/tasks/generate`** — accept **`containerId`** in the multipart form instead of `divisionId`. Look up the container (verify ownership) and derive `subjectId` + `divisionId` from it. Persist `containerId` on the `TaskPdfUpload`. Pass `containerId` into `processPdfInBackground`, which stamps every created `TaskQuestion` with it. Response unchanged (`{ uploadId }`).

`processPdfInBackground(uploadId, buffer, teacherId, subjectId, institutionId, prompt, more)` gains a `containerId` parameter and sets `containerId` on each created question.

No change to: `updateQuestionStatus`, `editQuestion`, `deleteQuestion`, `exportQuestions`, modules, tests, quiz.

## Response Shapes

Consistent `{ success: boolean, data?: T, error?: string }`.

Container object:
```ts
{ id: string; name: string; createdAt: string; questionCount: number }
```

## Frontend Wiring (`TasksTab.tsx`)

- Replace the hardcoded `c1`–`c13` array and the local `QContainer` interface with state loaded from `GET /teacher/tasks/containers?divisionId=`. The container type becomes `{ id; name; createdAt; questionCount }`.
- Add a `fetchContainers(divisionId)` callback; load on mount and after create/rename/delete.
- Wire the already-built create/rename/delete container UI to `POST` / `PATCH` / `DELETE`. The delete confirmation shows the container's `questionCount` ("This deletes the container AND its N questions").
- `handleGenerate` sends `containerId` (the open container's id) instead of `divisionId`.
- `fetchQuestions` takes a `containerId` and is called when a container is opened (and after generate/review actions). The pending-review flow happens inside the open container.
- Keep all folder open/close animations and existing layout; only the data source changes.

## Error Handling

- Missing/invalid `divisionId` or `containerId` → `400` (`BadRequestError`), matching existing controller conventions.
- Container not owned by the teacher / not found → `404` (`NotFoundError`).
- Generate with a `containerId` the teacher doesn't own → `404`.
- Frontend surfaces errors via the existing `apiError()` + `toast.error` pattern; no silent optimistic fallbacks for containers (unlike the old mock behavior).

## Testing

- **Backend (controller-level):** create container → appears in list with `questionCount: 0`; rename; generate into container stamps questions with `containerId`; `GET /questions?containerId=` returns only that container's questions; delete container cascade-removes its questions; cross-teacher access to another teacher's container returns 404; missing `containerId`/`divisionId` returns 400.
- **Frontend:** containers load from API (no mock); creating/renaming/deleting reflects within the live UI; generating into an open container shows its new questions after polling; deleting a non-empty container warns with the correct count.

## Success Criteria

1. No hardcoded container data remains in `TasksTab.tsx`.
2. Containers persist per `(teacher, subject, division)` and are independent across divisions.
3. Generating questions into a container files them under that container only.
4. Opening a container lists exactly its own questions.
5. Deleting a container removes the container and its questions (with a counted confirmation).
6. Every container/question query is scoped by `institutionId` (multi-tenancy preserved).
