import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { settingsRouter } from "./settings.routes";
import { booksRouter } from "./books.routes";
import { isbnRouter } from "./isbn.routes";
import { importRouter } from "./import.routes";
import { circulationRouter } from "./circulation.routes";
import { finesRouter } from "./fines.routes";
import { reportsRouter } from "./reports.routes";

export const libraryRouter = Router();
libraryRouter.use(
  authMiddleware(["ADMIN", "SUB_ADMIN"]),
  institutionAccessMiddleware,
  academicRoutingMiddleware,
  requirePermission("LIBRARY"),
);
libraryRouter.use("/settings", settingsRouter);
libraryRouter.use("/books", booksRouter);
libraryRouter.use("/isbn", isbnRouter);
libraryRouter.use("/import", importRouter);
libraryRouter.use("/fines", finesRouter);
libraryRouter.use("/reports", reportsRouter);
libraryRouter.use("/", circulationRouter);
