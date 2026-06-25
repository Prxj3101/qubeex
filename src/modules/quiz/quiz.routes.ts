// src/modules/quiz/quiz.routes.ts — public routes, no auth required
import { Router } from "express";
import {
  beaconSubmitQuiz,
  getAttemptDetailsForPdf,
  getAttemptResult,
  getQuizInfo,
  startQuiz,
  submitQuiz,
} from "../teacher/tasks.controller";

const router = Router();

router.get("/attempt/:id", getAttemptResult);
router.get("/attempt/:id/details-for-pdf", getAttemptDetailsForPdf);
router.post("/attempt/:testLink/submit", submitQuiz);
router.post("/attempt/:testLink/beacon-submit", beaconSubmitQuiz);
router.get("/test/:testLink", getQuizInfo);
router.post("/test/:testLink/start", startQuiz);
router.get("/:testLink", getQuizInfo);
router.post("/:testLink/start", startQuiz);
router.post("/:testLink/submit", submitQuiz);

export default router;
