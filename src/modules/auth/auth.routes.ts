import { Router } from "express";
import {
  verifyInvite,
  acceptInvite,
  login,
} from "./auth.controller";

const router = Router();

router.get("/invite/verify", verifyInvite);
router.post("/invite/accept", acceptInvite);
router.post("/login", login);

export default router;