import { Request, Response, NextFunction } from "express";
import * as service from "./superadmin.service";
import {
  createInstitutionSchema,
  updateInstitutionSchema,
  toggleStatusSchema,
} from "./superadmin.schema";

export const createInstitution = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = createInstitutionSchema.parse(req.body);
    const result = await service.createInstitutionService(data);

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getInstitutions = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitution();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getInstitution = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitutionById(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updataInstitution = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = updateInstitutionSchema.parse(req.body);
    const result = await service.updateInstitution(
      req.params.id as string,
      data
    );

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const toggleStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status } = toggleStatusSchema.parse(req.body);
    const result = await service.toggleInstitutionStatus(
      req.params.id as string,
      status
    );

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const resendInvite = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;
    const result = await service.resendInvite(email);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};