import { Request, Response } from "express";
import * as service from "./auth.service";
import { acceptInviteSchema, loginSchema } from "./auth.schema";

export const verifyInvite = async (req: Request, res: Response) => {
    try {
        const token = req.query.token as string;

        const data = await service.verifyInvite(token);

        res.status(200).json({
            success: true,
            data,
        });

    } catch (e: any) {
        res.status(400).json(
            {
                success: false,
                message: e.message
            }
        );
    }
}

export const acceptInvite = async (req: Request, res: Response) => {
    try {
        const {token,password} = acceptInviteSchema.parse(req.body);

        const data = await service.acceptInvite(token,password);

        res.status(200).json({
            success:true,
            data,
        })
    } catch (e:any) {
        res.status(400).json(
            {
                success:false,
                message:e.message
            }
        );
    }
}

export const login = async (req: Request, res: Response) => {
    try {
        const {email,password} = loginSchema.parse(req.body);

        const data = await service.login(email,password)

        res.json({
            status:true,
            data
        })
    } catch (e : any) {
        res.status(400).json({
            success:false,
            message:e.message,
        });
    }
}