import { ForbiddenError } from "./errors";

export interface AuthUser {
  userId: string;
  role: "SUPER_ADMIN" | "ADMIN";
  institutionId?: string;
  jti?: string;
}

export function checkInstitutionAccess(
  user: AuthUser,
  resourceInstitutionId: string
): void {
  if (user.role === "SUPER_ADMIN") return;

  if (!user.institutionId || user.institutionId !== resourceInstitutionId) {
    throw new ForbiddenError(
      "Access denied: you can only access your own institution's data"
    );
  }
}

export function getInstitutionFilter(user: AuthUser): {
  institutionId?: string;
} {
  if (user.role === "SUPER_ADMIN") return {};

  return { institutionId: user.institutionId };
}
