# Task Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded mock "Containers" in the subject-teacher Tasks → Questions tab with a persisted, division-scoped `TaskContainer` model so AI-generated questions live in per-topic folders.

**Architecture:** New `TaskContainer` model scoped to `(teacher, subject, division)`. `TaskQuestion` gains a required `containerId` (its single home folder, `onDelete: Cascade`). A question's division is derived through its container (normalized — Approach A). Backend gets container CRUD endpoints; `generate` and `listQuestions` switch their primary key from `divisionId` to `containerId`. Frontend swaps mock state for the real API.

**Tech Stack:** Node.js + Express + Prisma (PostgreSQL/Supabase), Zod, TypeScript strict. Frontend: Next.js App Router + React. Package manager: **pnpm only**.

## Testing Note (read first)

This repository has **no test framework** — neither backend nor frontend has a test runner or any `*.test.ts`/`*.spec.ts` files, and `package.json` has no `test` script. Standing one up for this feature is out of scope (the spec never called for it and it would violate "follow established patterns"). Therefore each task is verified by the project's real gates:

- **Backend:** `pnpm build` (runs `tsc` — full typecheck) must pass, plus a concrete `curl` check against the dev server (`pnpm dev`) where an endpoint changed.
- **Frontend:** `pnpm build` (runs `next build` — typechecks the app) must pass, plus a described manual UI check.

"Expected" outputs below are for these commands. Treat a clean build + the stated curl/UI result as the green bar.

## Global Constraints

- Every DB query MUST be scoped to `institutionId` (multi-tenancy — treat any cross-institution leak as a critical bug).
- Use **pnpm** for all commands — never npm or yarn.
- TypeScript strict mode — no `any` types.
- Use **named exports**, not default exports.
- Validate all request inputs with **Zod** before processing.
- API responses use the shape `{ success: boolean, data?: T, error?: string }`.
- Run `pnpm prisma generate` after any schema change.
- Backend working dir: `/home/hacksmith010/Programming/qubeex/backend`. Frontend working dir: `/home/hacksmith010/Programming/qubeex/qubeex-web`.
- Branch: `feat/task-containers` (already created).

---

## File Structure

**Backend** (`/home/hacksmith010/Programming/qubeex/backend`):
- `prisma/schema.prisma` — add `TaskContainer` model; add `containerId` to `TaskQuestion` and `TaskPdfUpload`; add `taskContainers` back-relations.
- `src/modules/teacher/tasks.schema.ts` — add `createContainerSchema`, `renameContainerSchema`; add `containerId` to `generateQuestionsSchema`.
- `src/modules/teacher/tasks.controller.ts` — add `listContainers`, `createContainer`, `renameContainer`, `deleteContainer`; modify `listQuestions`, `generateQuestions`, `processPdfInBackground`.
- `src/modules/teacher/teacher.routes.ts` — register the four container routes.

**Frontend** (`/home/hacksmith010/Programming/qubeex/qubeex-web`):
- `app/teacher/classes/[divisionId]/TasksTab.tsx` — replace mock container state with API-backed state + handlers; thread `containerId` into generate and `fetchQuestions`.

---

## Task 1: Schema — TaskContainer model + containerId columns

**Files:**
- Modify: `prisma/schema.prisma` (TaskQuestion ~848, TaskPdfUpload ~1004, Institution ~121, Teacher ~282, Subject ~487, Division ~462)

**Interfaces:**
- Produces: Prisma models `TaskContainer` (fields `id, institutionId, teacherId, subjectId, divisionId, name, questions, createdAt, updatedAt`); `TaskQuestion.containerId: string` (required, relation `container`, `onDelete: Cascade`); `TaskPdfUpload.containerId: string`.

- [ ] **Step 1: Add the `TaskContainer` model**

In `prisma/schema.prisma`, immediately **before** `model TaskQuestion {` (currently line 848), insert:

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

- [ ] **Step 2: Add `containerId` to `TaskQuestion`**

In `model TaskQuestion`, directly after the `subject Subject @relation(...)` line (currently line 855), add:

```prisma
  containerId   String
  container     TaskContainer @relation(fields: [containerId], references: [id], onDelete: Cascade)
```

- [ ] **Step 3: Add `containerId` to `TaskPdfUpload`**

In `model TaskPdfUpload`, directly after the `divisionId String` line (currently line 1010), add:

```prisma
  containerId   String
```

- [ ] **Step 4: Add back-relation arrays on the four parent models**

Add `taskContainers TaskContainer[]` to each, next to the existing `taskQuestions TaskQuestion[]` line:
- `model Institution` (after line 121 `taskQuestions TaskQuestion[]`)
- `model Teacher` (after line 282 `taskQuestions TaskQuestion[]`)
- `model Subject` (after line 487 `taskQuestions TaskQuestion[]`)
- `model Division` — it has no `taskQuestions`; add `taskContainers TaskContainer[]` next to its `taskTests TaskTest[]` line (line 462).

```prisma
  taskContainers     TaskContainer[]
```

- [ ] **Step 5: Wipe existing question/upload dev data (required column needs empty tables)**

Adding a required `containerId` to populated tables fails. Clear the dependent rows first:

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm prisma db execute --stdin <<'SQL'
DELETE FROM "TaskStudentAnswer";
DELETE FROM "TaskTestQuestion";
DELETE FROM "TaskModuleQuestion";
DELETE FROM "TaskQuestion";
DELETE FROM "TaskPdfUpload";
SQL
```
Expected: completes with no error (each statement reports success). If a table name differs, list them with `pnpm prisma db execute --stdin <<<'SELECT tablename FROM pg_tables WHERE tablename LIKE '"'"'Task%'"'"';'` and adjust.

- [ ] **Step 6: Push schema and regenerate client**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm prisma db push && pnpm prisma generate
```
Expected: `Your database is now in sync with your Prisma schema.` followed by `Generated Prisma Client`. No data-loss prompt should block (tables were emptied in Step 5).

- [ ] **Step 7: Verify the project still type-checks**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm build
```
Expected: exits 0. (Existing `taskQuestion.create` calls in `tasks.controller.ts` will now FAIL the build because `containerId` is required — this is expected and fixed in Task 5. If you are running tasks strictly in order, this build fails here; proceed to Step 8 to commit the schema, then Task 5 makes the build green. If you prefer a green build at every commit, do Task 5 before building.)

- [ ] **Step 8: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/backend && git add prisma/schema.prisma && git commit -m "feat(tasks): add TaskContainer model + required containerId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Zod schemas for container create/rename

**Files:**
- Modify: `src/modules/teacher/tasks.schema.ts`

**Interfaces:**
- Produces: `createContainerSchema` (parses `{ divisionId: string; name: string }`), `renameContainerSchema` (parses `{ name: string }`), and `generateQuestionsSchema` now additionally yields `containerId: string`.

- [ ] **Step 1: Add container schemas**

In `src/modules/teacher/tasks.schema.ts`, after `createModuleSchema`/`editModuleSchema` (line 28), add:

```typescript
export const createContainerSchema = z.object({
  divisionId: z.string().min(1),
  name: z.string().min(1).max(100).trim(),
});

export const renameContainerSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});
```

- [ ] **Step 2: Add `containerId` to `generateQuestionsSchema`**

Replace the existing `generateQuestionsSchema` (lines 4–8) with:

```typescript
export const generateQuestionsSchema = z.object({
  containerId: z.string().uuid(),
  prompt: z.string().max(500).trim().optional(),
  more: z.boolean().optional().default(false),
});
```
(Note: `divisionId` is removed — generate now keys off the container.)

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm exec tsc --noEmit src/modules/teacher/tasks.schema.ts 2>&1 | head
```
Expected: no output related to `tasks.schema.ts` syntax (it references only `z`). A clean run prints nothing or only unrelated project-wide errors deferred to later tasks.

- [ ] **Step 4: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/backend && git add src/modules/teacher/tasks.schema.ts && git commit -m "feat(tasks): zod schemas for container CRUD + containerId on generate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Container CRUD controllers + routes

**Files:**
- Modify: `src/modules/teacher/tasks.controller.ts` (add four exports near the module controllers, ~line 1020)
- Modify: `src/modules/teacher/teacher.routes.ts` (import block ~108, route block ~785)

**Interfaces:**
- Consumes: `requireTeacher(req)`, `getTeacherId(userId, institutionId)`, `resolveSubjectAssignment(teacherId, divisionId, institutionId)`, `BadRequestError`, `NotFoundError`, `createContainerSchema`, `renameContainerSchema` (Task 2).
- Produces: exported handlers `listContainers`, `createContainer`, `renameContainer`, `deleteContainer`. Container response object: `{ id, name, createdAt, questionCount: number, ...other fields }`.

- [ ] **Step 1: Import the new schemas in the controller**

In `src/modules/teacher/tasks.controller.ts`, add `createContainerSchema,` and `renameContainerSchema,` to the import from `"./tasks.schema"` (the block starting line 8).

- [ ] **Step 2: Add the four container controllers**

In `src/modules/teacher/tasks.controller.ts`, immediately before `export const listModules` (line 1020), insert:

```typescript
// ── Containers ────────────────────────────────────────────────────────────────
export const listContainers = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const containers = await prisma.taskContainer.findMany({
      where: { teacherId, subjectId, divisionId, institutionId },
      include: { _count: { select: { questions: true } } },
      orderBy: { createdAt: "desc" },
    });

    const data = containers.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      questionCount: c._count.questions,
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const createContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createContainerSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId);

    const container = await prisma.taskContainer.create({
      data: { institutionId, teacherId, subjectId, divisionId: data.divisionId, name: data.name },
    });

    res.status(201).json({
      success: true,
      data: { id: container.id, name: container.name, createdAt: container.createdAt, questionCount: 0 },
    });
  } catch (err) { next(err); }
};

export const renameContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const { name } = renameContainerSchema.parse(req.body);

    const container = await prisma.taskContainer.findFirst({ where: { id, teacherId, institutionId } });
    if (!container) throw new NotFoundError("Container not found");

    const updated = await prisma.taskContainer.update({
      where: { id },
      data: { name },
      include: { _count: { select: { questions: true } } },
    });

    res.json({
      success: true,
      data: { id: updated.id, name: updated.name, createdAt: updated.createdAt, questionCount: updated._count.questions },
    });
  } catch (err) { next(err); }
};

export const deleteContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const container = await prisma.taskContainer.findFirst({ where: { id, teacherId, institutionId } });
    if (!container) throw new NotFoundError("Container not found");

    // onDelete: Cascade on TaskQuestion.containerId removes the questions inside.
    await prisma.taskContainer.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) { next(err); }
};
```

- [ ] **Step 3: Import the handlers in routes**

In `src/modules/teacher/teacher.routes.ts`, add to the import block from `"./tasks.controller"` (before line 114 `} from "./tasks.controller";`):

```typescript
  listContainers,
  createContainer,
  renameContainer,
  deleteContainer,
```

- [ ] **Step 4: Register the routes**

In `src/modules/teacher/teacher.routes.ts`, directly after the `// ── Tasks — PDF Generation ──` block (after line 764 `router.get("/tasks/uploads/:id", ...T, getUploadStatus);`), add:

```typescript
// ── Tasks — Containers ────────────────────────────────────────────────────────
router.get("/tasks/containers", ...T, listContainers);
router.post("/tasks/containers", ...T, createContainer);
router.patch("/tasks/containers/:id", ...T, renameContainer);
router.delete("/tasks/containers/:id", ...T, deleteContainer);
```

- [ ] **Step 5: Verify build (after Task 5 is also done) / typecheck this file**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm build 2>&1 | grep -E "tasks.(controller|routes)" || echo "no errors in tasks files"
```
Expected: `no errors in tasks files` (the controller/routes compile). The only remaining build errors at this point come from the still-unedited `taskQuestion.create` calls (fixed in Task 5).

- [ ] **Step 6: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/backend && git add src/modules/teacher/tasks.controller.ts src/modules/teacher/teacher.routes.ts && git commit -m "feat(tasks): container CRUD endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: listQuestions filters by containerId

**Files:**
- Modify: `src/modules/teacher/tasks.controller.ts` (`listQuestions`, currently lines 540–564)

**Interfaces:**
- Consumes: `prisma.taskContainer`, `requireTeacher`, `getTeacherId`, `BadRequestError`, `NotFoundError`.
- Produces: `GET /teacher/tasks/questions?containerId=<uuid>&status=<optional>` returns that container's questions.

- [ ] **Step 1: Replace the `listQuestions` body**

Replace lines 540–564 (the whole `export const listQuestions = ...` block) with:

```typescript
export const listQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const containerId = req.query.containerId as string;
    const statusFilter = req.query.status as string | undefined;

    if (!containerId) throw new BadRequestError("containerId query param is required");

    const container = await prisma.taskContainer.findFirst({
      where: { id: containerId, teacherId, institutionId },
      select: { id: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    const questions = await prisma.taskQuestion.findMany({
      where: {
        containerId, teacherId, institutionId,
        ...(statusFilter && ["PENDING_REVIEW", "APPROVED", "REJECTED"].includes(statusFilter)
          ? { status: statusFilter as "PENDING_REVIEW" | "APPROVED" | "REJECTED" }
          : {}),
      },
      include: { moduleAssignment: { select: { moduleId: true, module: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: questions });
  } catch (err) { next(err); }
};
```

- [ ] **Step 2: Verify the controller compiles for this change**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm build 2>&1 | grep -E "listQuestions|540|541|542" || echo "listQuestions ok"
```
Expected: `listQuestions ok`.

- [ ] **Step 3: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/backend && git add src/modules/teacher/tasks.controller.ts && git commit -m "feat(tasks): list questions by containerId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: generate writes into a container

**Files:**
- Modify: `src/modules/teacher/tasks.controller.ts` (`generateQuestions` ~465–506, `processPdfInBackground` signature ~284 and its `taskQuestion.create` calls)

**Interfaces:**
- Consumes: `createContainer` data model, `generateQuestionsSchema` (now `{ containerId, prompt?, more? }`).
- Produces: `processPdfInBackground(uploadId, buffer, teacherId, subjectId, institutionId, promptText, more, containerId)` — every question it creates carries `containerId`.

- [ ] **Step 1: Rewrite `generateQuestions` to key off the container**

Replace the body of `generateQuestions` (lines 465–506) with:

```typescript
export const generateQuestions = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);

    if (!req.file) throw new BadRequestError("PDF file is required");

    const body = generateQuestionsSchema.parse({
      containerId: req.body.containerId,
      prompt: req.body.prompt,
      more: req.body.more === "true" || req.body.more === true,
    });

    const container = await prisma.taskContainer.findFirst({
      where: { id: body.containerId, teacherId, institutionId },
      select: { id: true, subjectId: true, divisionId: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    // Record the upload
    const upload = await prisma.taskPdfUpload.create({
      data: {
        institutionId, teacherId,
        divisionId: container.divisionId,
        containerId: container.id,
        displayName: req.file.originalname || "Uploaded PDF",
        originalName: req.file.originalname || "upload.pdf",
        status: "processing",
      },
    });

    // Fire-and-forget background processing
    const buffer = req.file.buffer;
    setImmediate(() => {
      processPdfInBackground(
        upload.id, buffer, teacherId, container.subjectId, institutionId,
        body.prompt ?? "", body.more ?? false, container.id
      );
    });

    res.status(202).json({ success: true, data: { uploadId: upload.id } });
  } catch (err) { next(err); }
};
```

- [ ] **Step 2: Add `containerId` parameter to `processPdfInBackground`**

In the signature (lines 284–292), add a final parameter. Replace:

```typescript
async function processPdfInBackground(
  uploadId: string,
  buffer: Buffer,
  teacherId: string,
  subjectId: string,
  institutionId: string,
  promptText: string,
  more: boolean
) {
```
with:
```typescript
async function processPdfInBackground(
  uploadId: string,
  buffer: Buffer,
  teacherId: string,
  subjectId: string,
  institutionId: string,
  promptText: string,
  more: boolean,
  containerId: string
) {
```

- [ ] **Step 3: Stamp `containerId` on every created question**

Every `taskQuestion.create` inside `processPdfInBackground` has a `data: { institutionId, teacherId, subjectId, ... }` block (six call sites: ~336, 384, 397, 410, 423, 435). In each, add `containerId,` right after `subjectId,`. The literal substring `institutionId, teacherId, subjectId,` is identical across them, so a scoped find-and-replace within this function works:

Replace each occurrence of:
```typescript
              institutionId, teacherId, subjectId,
```
with:
```typescript
              institutionId, teacherId, subjectId, containerId,
```
Verify you changed exactly six occurrences (all within `processPdfInBackground`). If indentation differs at a site, match it but keep the same insertion.

- [ ] **Step 4: Full backend build (now green end-to-end)**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/backend && pnpm build
```
Expected: exits 0, no errors. This is the first fully green build since Task 1.

- [ ] **Step 5: Manual smoke test against the running server**

Start the server in one shell: `cd /home/hacksmith010/Programming/qubeex/backend && pnpm dev`. With a valid teacher auth token (`$TOKEN`) and a `divisionId` (`$DIV`) the teacher teaches:

```bash
# create a container
curl -s -X POST localhost:8000/api/teacher/tasks/containers \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"divisionId\":\"$DIV\",\"name\":\"Chapter 1\"}"
# -> {"success":true,"data":{"id":"...","name":"Chapter 1","createdAt":"...","questionCount":0}}

# list containers
curl -s "localhost:8000/api/teacher/tasks/containers?divisionId=$DIV" -H "Authorization: Bearer $TOKEN"
# -> {"success":true,"data":[{"id":"...","name":"Chapter 1","createdAt":"...","questionCount":0}]}

# list questions in the container (empty)
curl -s "localhost:8000/api/teacher/tasks/questions?containerId=<id-from-above>" -H "Authorization: Bearer $TOKEN"
# -> {"success":true,"data":[]}
```
Expected: the shapes shown above. (Confirm the API base path/port from `src/server.ts` if different from `localhost:8000/api`.)

- [ ] **Step 6: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/backend && git add src/modules/teacher/tasks.controller.ts && git commit -m "feat(tasks): generate questions into a container

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Frontend — load containers from the API

**Files:**
- Modify: `qubeex-web/app/teacher/classes/[divisionId]/TasksTab.tsx` (container state ~222–250, fetch callbacks ~349–414, effects)

**Interfaces:**
- Consumes: `GET /teacher/tasks/containers?divisionId=`.
- Produces: `QContainer = { id: string; name: string; createdAt: string; questionCount: number }`; `fetchContainers()` callback; container state populated from API (no mock rows).

- [ ] **Step 1: Replace the `QContainer` type and mock state**

In `TasksTab.tsx`, replace the `QContainer` interface and the mock-filled `useState` (lines 223–238) with:

```tsx
    interface QContainer { id: string; name: string; createdAt: string; questionCount: number; }
    const [containers, setContainers] = useState<QContainer[]>([]);
    const [containersLoading, setContainersLoading] = useState(true);
```

- [ ] **Step 2: Add a `fetchContainers` callback**

Next to the other fetch callbacks (near `fetchModules`, ~line 389), add:

```tsx
    const fetchContainers = useCallback(async () => {
        setContainersLoading(true);
        try {
            const res = await api.get(`/teacher/tasks/containers?divisionId=${divisionId}`);
            setContainers(res.data.data);
        } catch {
            setContainers([]);
        } finally {
            setContainersLoading(false);
        }
    }, [divisionId]);
```

- [ ] **Step 3: Load containers on mount**

Near the other load effects (~line 401), add:

```tsx
    useEffect(() => {
        fetchContainers();
    }, [fetchContainers]);
```

- [ ] **Step 4: Verify the app type-checks/builds**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && pnpm build 2>&1 | tail -20
```
Expected: build succeeds. (If it fails because inline JSX still pushes mock objects without `questionCount`, that is fixed in Task 7 — if running strictly in order, you may instead run `pnpm lint` here and defer the full build to Task 7. Prefer doing Task 7 before the green-build gate.)

- [ ] **Step 5: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && git add app/teacher/classes/[divisionId]/TasksTab.tsx && git commit -m "feat(tasks): load containers from API instead of mock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Frontend — wire container create / rename / delete

**Files:**
- Modify: `qubeex-web/app/teacher/classes/[divisionId]/TasksTab.tsx` (inline handlers at create ~947/956, rename ~1073/1079, delete ~1758)

**Interfaces:**
- Consumes: `POST/PATCH/DELETE /teacher/tasks/containers`, `fetchContainers` (Task 6), the `apiError()` + `toast` helpers already in the file.
- Produces: async handlers `handleCreateContainer(name)`, `handleRenameContainer(id, name)`, `handleDeleteContainer(id)`.

- [ ] **Step 1: Add the three handlers**

Near `handleContainerClick` (~line 265), add:

```tsx
    const handleCreateContainer = async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
            const res = await api.post('/teacher/tasks/containers', { divisionId, name: trimmed });
            setContainers(prev => [res.data.data, ...prev]);
            toast.success('Container created');
        } catch (err) { toast.error(apiError(err)); }
        finally { setCreatingContainer(false); setNewContainerName(''); }
    };

    const handleRenameContainer = async (id: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) { setEditingContainerId(null); return; }
        try {
            const res = await api.patch(`/teacher/tasks/containers/${id}`, { name: trimmed });
            setContainers(prev => prev.map(c => c.id === id ? { ...c, name: res.data.data.name } : c));
        } catch (err) { toast.error(apiError(err)); }
        finally { setEditingContainerId(null); }
    };

    const handleDeleteContainer = async (id: string) => {
        try {
            await api.delete(`/teacher/tasks/containers/${id}`);
            setContainers(prev => prev.filter(c => c.id !== id));
            toast.success('Container deleted');
        } catch (err) { toast.error(apiError(err)); }
        finally { setDeleteConfirmId(null); }
    };
```

- [ ] **Step 2: Replace the inline create handlers**

The create input has two call sites (Enter key ~947, button ~955–956) that do `setContainers(prev => [...prev, { id: crypto.randomUUID(), name: newContainerName.trim(), createdAt: ... }])`. Replace both with a call to `handleCreateContainer(newContainerName)`:

- The `onKeyDown` Enter branch becomes:
```tsx
                                                if (e.key === 'Enter' && newContainerName.trim()) {
                                                    handleCreateContainer(newContainerName);
                                                }
```
- The confirm button `onClick` becomes:
```tsx
                                            if (!newContainerName.trim()) return;
                                            handleCreateContainer(newContainerName);
```

- [ ] **Step 3: Replace the inline rename handlers**

The rename input (editing branch ~1073 on Enter, ~1079 on blur) does `setContainers(prev => prev.map(...))`. Replace both with `handleRenameContainer(c.id, editingName)`:
```tsx
                                                                handleRenameContainer(c.id, editingName);
```
(Apply at both the Enter-key branch and the blur/confirm branch; remove the now-redundant local `setContainers(...)` and `setEditingContainerId(null)` calls that the handler now owns.)

- [ ] **Step 4: Wire the delete confirm + show the question count**

In the delete-confirm modal (~line 1730–1760), the body text uses the container name; include the count. Replace the confirmation sentence (~line 1750) so it reads:

```tsx
                                        "{containers.find(c => c.id === deleteConfirmId)?.name}" and its {containers.find(c => c.id === deleteConfirmId)?.questionCount ?? 0} question(s) will be permanently deleted. This cannot be undone.
```
And replace the confirm button `onClick` (~line 1758) with:
```tsx
                                    onClick={() => handleDeleteContainer(deleteConfirmId)}
```

- [ ] **Step 5: Build**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && pnpm build 2>&1 | tail -20
```
Expected: build succeeds, no type errors.

- [ ] **Step 6: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && git add app/teacher/classes/[divisionId]/TasksTab.tsx && git commit -m "feat(tasks): wire container create/rename/delete to API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Frontend — generate + list questions by container

**Files:**
- Modify: `qubeex-web/app/teacher/classes/[divisionId]/TasksTab.tsx` (`handleGenerate` ~452–473, `fetchQuestions` ~351–363 and its callers)

**Interfaces:**
- Consumes: `POST /teacher/tasks/generate` (now needs `containerId`), `GET /teacher/tasks/questions?containerId=`.
- Produces: generate sends the open container's id; `fetchQuestions(containerId, status?)` loads a container's questions.

- [ ] **Step 1: Send `containerId` from `handleGenerate`**

In `handleGenerate` (~line 456–460), replace the form field append:
```tsx
            form.append('divisionId', divisionId);
```
with (guard that a container is open):
```tsx
            if (!selectedContainerId) return toast.error('Open a container first');
            form.append('containerId', selectedContainerId);
```

- [ ] **Step 2: Make `fetchQuestions` take a containerId**

Replace `fetchQuestions` (lines 351–363) with:
```tsx
    const fetchQuestions = useCallback(async (containerId: string, status?: string) => {
        setQLoading(true);
        try {
            const params = new URLSearchParams({ containerId });
            if (status && status !== 'ALL') params.set('status', status);
            const res = await api.get(`/teacher/tasks/questions?${params}`);
            setQuestions(res.data.data);
        } catch {
            setQuestions([]);
        } finally {
            setQLoading(false);
        }
    }, []);
```

- [ ] **Step 3: Update `fetchQuestions` callers**

The mount effect `useEffect(() => { fetchQuestions(); }, [fetchQuestions])` (~line 401) must not fire without a container. Replace it with an effect keyed on the open container:
```tsx
    useEffect(() => {
        if (selectedContainerId) fetchQuestions(selectedContainerId, statusFilter !== 'ALL' ? statusFilter : undefined);
        else setQuestions([]);
    }, [selectedContainerId, statusFilter, fetchQuestions]);
```
Then update the other call sites to pass the container: the status-filter refresh button (~line 1125) and any post-generate / post-review refresh — each `fetchQuestions(...)` call becomes `selectedContainerId && fetchQuestions(selectedContainerId, ...)`. Search the file for `fetchQuestions(` and fix every call to pass `selectedContainerId` as the first argument.

- [ ] **Step 4: Build**

Run:
```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && pnpm build 2>&1 | tail -20
```
Expected: build succeeds, no type errors. Confirm there are no remaining `fetchQuestions()` calls without a container argument:
```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && grep -n "fetchQuestions(" app/teacher/classes/[divisionId]/TasksTab.tsx
```
Expected: every call passes a containerId (or is the definition).

- [ ] **Step 5: Manual end-to-end UI check**

With backend (`pnpm dev`) and frontend (`pnpm dev`) running, as a subject teacher: open a division → Tasks → Questions. Create a container; it persists across reload. Open it, upload a PDF, confirm generated questions appear inside that container only and not in a second container. Delete the container; confirm the dialog shows the question count and the questions are gone after deletion.

- [ ] **Step 6: Commit**

```bash
cd /home/hacksmith010/Programming/qubeex/qubeex-web && git add app/teacher/classes/[divisionId]/TasksTab.tsx && git commit -m "feat(tasks): generate into + list questions by container

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] Backend builds clean: `cd /home/hacksmith010/Programming/qubeex/backend && pnpm build` → exits 0.
- [ ] Frontend builds clean: `cd /home/hacksmith010/Programming/qubeex/qubeex-web && pnpm build` → succeeds.
- [ ] No hardcoded `c1`–`c13` container data remains: `grep -n "Chapter 1 : DFS Questions" qubeex-web/app/teacher/classes/[divisionId]/TasksTab.tsx` → no matches.
- [ ] All container/question queries are scoped by `institutionId` (review the four new controllers).
