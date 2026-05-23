# Student Auth & Onboarding Design

**Date:** 2026-05-23
**Scope:** Student account creation by class teachers, student login via custom Login ID, forced password change on first login.

---

## Overview

Students are onboarded by their class teacher. The teacher creates student accounts one at a time for their assigned class/division. Each student gets a system-generated Login ID and a predictable default password. The student cannot access any part of the app until they change their password on first login.

Admins have read/deactivate access over all students in their institution. No student self-registration exists.

---

## Login ID Format

```
STUDENT-{INST_TYPE}-{INST_CODE}-{COUNT}
```

| Part        | Description                                              | Example   |
|-------------|----------------------------------------------------------|-----------|
| `STUDENT`   | Literal role prefix                                      | `STUDENT` |
| `INST_TYPE` | Institution type abbreviation                            | `COLL`, `SCH`, `COCH` |
| `INST_CODE` | Institution's `institutionCode` from DB                  | `DYP01`   |
| `COUNT`     | Auto-incremented count of students added to institution, zero-padded to 4 digits | `0042` |

**Examples:**
```
STUDENT-COLL-DYP01-0042   ← 42nd student added to DY Patil College
STUDENT-SCH-MHS01-0003    ← 3rd student added to MH School
STUDENT-COCH-ACE01-0099   ← 99th student added to ACE Coaching
```

Institution type map:
- `SCH`  → School
- `COLL` → College
- `COCH` → Coaching

The `COUNT` is derived at account creation time by counting existing students at that institution and incrementing by 1. This count is stored on the `User` record as part of the `loginId` — it never changes even if other students are deleted.

---

## Default Password

```
{first4LettersOfFirstName}{ddmmyyyy}
```

Rules:
- Take the first name (first word of `name`)
- Take up to 4 characters — first letter uppercase, remaining lowercase
- If name is shorter than 4 letters, use the full first name
- Append full date of birth in `ddmmyyyy` format (no separators)

**Examples:**
```
Prajwal Kotian, DOB 31/05/2001  →  Praj31052001
Ali Khan,       DOB 15/08/1999  →  Ali15081999
Sneha Patil,    DOB 03/11/2003  →  Sneh03112003
```

This password is hashed with bcrypt before storage. The plaintext is shown to the teacher once at creation time (never stored or retrievable again).

---

## Schema Changes

Two fields added to the existing `User` model:

```prisma
model User {
  // ... existing fields unchanged ...
  loginId            String?  @unique   // only set for role STUDENT
  mustChangePassword Boolean  @default(false)
}
```

- `loginId` is `null` for teachers, admins, and superadmins — they continue to use email-based login unchanged.
- `mustChangePassword` is `true` for all new student accounts and reset to `true` on password recovery.

No changes to `Student` model. The `studentId` field on `Student` stores the institution roll number (assigned by teacher, for internal records only — not used for login).

---

## API Endpoints

### Teacher Creates a Student
```
POST /api/teacher/students
Auth: Bearer token (role: TEACHER)
Body: {
  name: string,
  rollNo: string,        // stored on Student.studentId — for records only
  dob: string,           // format: "YYYY-MM-DD"
  standardId: string,
  divisionId: string,
  phone?: string,
  email?: string
}
```

**Backend flow:**
1. Verify teacher belongs to the same institution.
2. Count existing students at institution → `nextCount` = count + 1.
3. Derive `INST_TYPE` from institution's type field.
4. Generate `loginId`: `STUDENT-{INST_TYPE}-{INST_CODE}-{nextCount padded to 4}`.
5. Derive default password: first 4 chars of first name (first letter caps) + `ddmmyyyy` from dob.
6. Hash default password with bcrypt (12 rounds).
7. In a transaction:
   - Create `User` `{ loginId, password: hashed, role: STUDENT, isActive: true, mustChangePassword: true, institutionId }`
   - Create `Student` `{ studentId: rollNo, userId, institutionId, standardId, divisionId, dob, phone?, ... }`
8. Return `{ loginId, defaultPassword }` — plaintext shown to teacher **once only**.

**Response:**
```json
{
  "success": true,
  "data": {
    "loginId": "STUDENT-COLL-DYP01-0043",
    "defaultPassword": "Praj31052001",
    "studentId": "..."
  }
}
```

---

### Student Login
```
POST /api/student/auth/login
Body: {
  loginId: string,    // e.g. "STUDENT-COLL-DYP01-0042"
  password: string
}
```

**Backend flow:**
1. Parse `loginId` — validate format matches `STUDENT-{TYPE}-{CODE}-{NUM}` pattern.
2. Find `User` by `loginId` where `role = STUDENT`.
3. Check `user.isActive` — return 401 if inactive.
4. Verify password with bcrypt.
5. Record failed attempts in Redis (same lockout logic as existing auth — 5 attempts, 15 min lockout).
6. Issue JWT: `{ userId, role: 'STUDENT', institutionId, jti }`.
7. Include `mustChangePassword` flag in response.

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "...",
    "mustChangePassword": true,
    "user": { "id": "...", "name": "Prajwal Kotian", "loginId": "STUDENT-COLL-DYP01-0042" }
  }
}
```

---

### Force Password Change (First Login Gate)

All student-protected routes check `mustChangePassword`. If `true`, every route except `/set-password` and `/logout` returns:
```json
{ "success": false, "error": "PASSWORD_CHANGE_REQUIRED" }
```
with HTTP `403`. The app intercepts this and redirects to the change-password screen. The student cannot bypass this by hitting APIs directly.

```
POST /api/student/auth/set-password
Auth: Bearer token (role: STUDENT)
Body: {
  newPassword: string   // min 8 chars
}
```

Sets new bcrypt-hashed password, sets `mustChangePassword: false`. Student now has full access.

---

### Password Recovery (Teacher-Driven)

No email OTP. Teacher resets the student's password back to default:

```
POST /api/teacher/students/:studentId/reset-password
Auth: Bearer token (role: TEACHER)
```

**Backend flow:**
1. Verify student belongs to teacher's institution.
2. Re-derive default password from student's `name` + `dob`.
3. Hash and update `User.password`.
4. Set `mustChangePassword: true`.
5. Return `{ defaultPassword }` to teacher — shown once.

---

### Student Logout
```
POST /api/student/auth/logout
Auth: Bearer token
```
Blacklists JWT `jti` in Redis (same as existing logout). No changes needed.

---

## Auth Middleware Impact

Existing `authMiddleware` works unchanged — it validates JWT and checks role. No modification needed.

A new `requirePasswordChanged` middleware is added for all student routes:

```typescript
// Applied to all /api/student/* routes except /auth/*
if (req.user.role === 'STUDENT' && user.mustChangePassword) {
  return res.status(403).json({ success: false, error: 'PASSWORD_CHANGE_REQUIRED' });
}
```

---

## Admin Monitoring

No new endpoints needed immediately. Existing admin routes can be extended to:
- `GET /api/admin/students` — list all students in institution with status
- `PATCH /api/admin/students/:id/deactivate` — set `isActive: false`
- `PATCH /api/admin/students/:id/activate` — set `isActive: true`

Deactivated students get 401 on login. Their data is retained per the 90-day retention policy.

---

## Security Notes

- Login ID format is public knowledge (students know their own ID) — security relies entirely on the password.
- Default password is shown to the teacher once. It is never stored in plaintext, never logged.
- `mustChangePassword` is enforced both at the API layer (middleware) and in the JWT response flag — the app cannot skip it even if modified.
- Same Redis lockout applies: 5 failed attempts → 15 min lock on the `loginId`.
- Student JWT is blacklisted on logout via `jti` — same as all other roles.
