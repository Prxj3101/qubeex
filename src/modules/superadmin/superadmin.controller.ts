import { Request, Response } from "express";
import * as service from "../superadmin/superadmin.service";
import {
    createInstitutionSchema,
    updateInstitutionSchema,
    toggleStatusSchema
} from "../superadmin/superadmin.schema";

export const createInstitution = async (req: Request, res: Response) => {
    try {
        const data = createInstitutionSchema.parse(req.body);

        const result = await service.createInstitutionService(data);

        res.status(201).json({
            success: true,
            data: result,
        });
    } catch (error: any) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const getInstitutions = async (_req: Request, res: Response) => {
    const data = await service.getInstitution();
    res.json({
        success: true,
        data,
    });
};

export const getInstitution = async (req: Request, res: Response) => {
    try {
        const data = await service.getInstitutionById(req.params.id as string);
        res.json({
            success: true,
            data
        })

    } catch (e: any) {
        res.status(404).json({
            success: false,
            message: e.message,
        })
    }
}

export const updataInstitution = async (req: Request, res: Response) => {
    try {
        const data = updateInstitutionSchema.parse(req.body);

        const result = await service.updateInstitution(req.params.id as string, data);

        res.json({
            success: true,
            data: result
        });
    } catch (e: any) {
        res.status(400).json({
            success: false,
            message: e.message,
        })
    }
}

export const toggleStatus = async (req: Request, res: Response) => {
    try {
        const { status } = toggleStatusSchema.parse(req.body);

        const result = await service.toggleInstitutionStatus(
            req.params.id as string,
            status
        );

        res.json({
            success: true,
            data: result
        });
    } catch (e: any) {
        res.status(400).json({
            success: false,
            message: e.message
        });
    }
};

export const resendInvite = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;

        const result = await service.resendInvite(email);

        res.json({
            success: true,
            data: result
        });
    } catch (e: any) {
        res.status(400).json({
            success: false,
            message: e.message
        });
    }
};