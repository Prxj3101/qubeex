import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { getMyInstitution } from "./admin.controller";

const router = Router();

router.get("/me", authMiddleware(["ADMIN"]), getMyInstitution);

export default router;