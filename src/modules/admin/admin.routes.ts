import { Router, raw } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { getMyInstitution, updateMyInstitution, uploadMyInstitutionLogo } from "./admin.controller";

const router = Router();

const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

router.get("/me", ...A, getMyInstitution);
router.patch("/institution", ...A, updateMyInstitution);
router.post(
  "/institution/logo",
  ...A,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadMyInstitutionLogo
);

export default router;
