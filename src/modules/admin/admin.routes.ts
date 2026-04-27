import { Router, raw } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { getMyInstitution, updateMyInstitution, uploadMyInstitutionLogo } from "./admin.controller";

const router = Router();

router.get("/me", authMiddleware(["ADMIN"]), getMyInstitution);
router.patch("/institution", authMiddleware(["ADMIN"]), updateMyInstitution);
router.post(
  "/institution/logo",
  authMiddleware(["ADMIN"]),
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadMyInstitutionLogo
);

export default router;
