import { Request, Response, NextFunction } from "express";
import { createDemoRequestSchema } from "./demoRequest.schema";
import { createDemoRequest } from "./demoRequest.service";

export const submitDemoRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = createDemoRequestSchema.parse(req.body);
    const { demoRequest } = await createDemoRequest(input);
    res.status(201).json({
      success: true,
      data: { id: demoRequest.id, status: demoRequest.status },
    });
  } catch (error) {
    next(error);
  }
};
