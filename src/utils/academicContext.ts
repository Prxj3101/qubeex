import { AsyncLocalStorage } from "async_hooks";
import type { PrismaClient } from "../generated/prisma/client";

// The client used for academic (institution-owned) data. For managed institutions
// this is the central Prisma client; for BYOD institutions it's their tenant client,
// duck-typed to the same delegate surface. Typed as the central client so existing
// academic code typechecks unchanged.
export type AcademicClient = PrismaClient;

const als = new AsyncLocalStorage<{ client: AcademicClient }>();

/** Run `fn` with `client` as the active academic client for the async scope. */
export const runWithAcademicClient = <T>(client: AcademicClient, fn: () => T): T =>
  als.run({ client }, fn);

/**
 * The academic client for the current request/async scope.
 * Throws if called outside a context — request handlers get it via the routing
 * middleware; crons/scripts must wrap work in `runWithAcademicClient(...)`.
 */
export const academicDb = (): AcademicClient => {
  const store = als.getStore();
  if (!store) {
    throw new Error(
      "No academic client in context — call within a request or wrap work in runWithAcademicClient()."
    );
  }
  return store.client;
};

/** True when an academic client is available in the current scope. */
export const hasAcademicContext = (): boolean => als.getStore() != null;
