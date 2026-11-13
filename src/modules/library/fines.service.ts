import type { LibraryFine, LibrarySettings, PrismaClient } from "../../generated/prisma/client";
import { BorrowerType, RuleSet, computeLateFinePaise } from "./library.rules";

type FineDb = Pick<PrismaClient, "libraryFine">;

export type ReturnCondition = "OK" | "DAMAGED" | "LOST";

export async function createFinesForReturn(
  tx: FineDb,
  args: {
    institutionId: string;
    loan: { id: string; borrowerUserId: string; dueAt: Date };
    condition: ReturnCondition;
    returnedAt: Date;
    borrowerType: BorrowerType;
    settings: Pick<LibrarySettings, "finesMode" | "lostChargePaise" | "damagedChargePaise">;
    rule: RuleSet;
  },
): Promise<LibraryFine[]> {
  const { institutionId, loan, condition, returnedAt, borrowerType, settings, rule } = args;
  if (settings.finesMode === "OFF") return [];

  // Fees only exist for students; everyone else is collected at the desk.
  const collectedVia = settings.finesMode === "FEES" && borrowerType === "STUDENT" ? "FEES" : "LIBRARIAN";

  const charges: { kind: "LATE" | "LOST" | "DAMAGED"; amountPaise: number }[] = [];
  charges.push({ kind: "LATE", amountPaise: computeLateFinePaise(loan.dueAt, returnedAt, rule) });
  if (condition === "LOST") charges.push({ kind: "LOST", amountPaise: settings.lostChargePaise });
  if (condition === "DAMAGED") charges.push({ kind: "DAMAGED", amountPaise: settings.damagedChargePaise });

  const created: LibraryFine[] = [];
  for (const charge of charges.filter((c) => c.amountPaise > 0)) {
    created.push(await tx.libraryFine.create({
      data: { institutionId, loanId: loan.id, borrowerUserId: loan.borrowerUserId, kind: charge.kind, amountPaise: charge.amountPaise, collectedVia, status: "PENDING" },
    }));
  }
  return created;
}
