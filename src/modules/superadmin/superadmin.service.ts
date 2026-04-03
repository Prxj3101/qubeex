import { fa } from "zod/v4/locales";
import { prisma } from "../../utils/prisma";
import { generateToken } from "../../utils/token";
import { sendInviteEmail } from "../../services/email.service";

export const createInstitutionService = async (data: any) => {

    const { name, email, type, adminName, adminEmail } = data;

    const existingInstitution = await prisma.institution.findUnique({
        where:{email},
    });

    if(existingInstitution){
        throw new Error("Institution already exists");
    }

    const existingAdmin = await prisma.user.findUnique({
        where :{email:adminEmail},
    })

    if(existingAdmin){
        throw new Error("Admin already exists");
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const institution = await prisma.$transaction(async(tx) => {
        const newInstitution = await tx.institution.create({
            data:{
                name,
                email,
                type,
            }
        });

        await tx.user.create({
            data:{
                name:adminName,
                email:adminEmail,
                role:"ADMIN",
                institutionId : newInstitution.id,
                isActive:false,
            },
        });

        await tx.invite.create({
            data:{
                email:adminEmail,
                token,
                role:"ADMIN",
                institutionId:newInstitution.id,
                expiresAt,
            },
        });

        return newInstitution;
    });

    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${token}`;

    await sendInviteEmail({
        to:adminEmail,
        inviteLink,
    });

    return institution;
}

export const getInstitution = async () => {
    return prisma.institution.findMany({
        include:{
            users:true,
            subscription:true,
        },
        orderBy: {createdAt : "desc"},
    });
};

export const getInstitutionById = async (id:string) => {
    const institution = await prisma.institution.findUnique({
        where : {id},
        include:{
            users:true,
            subscription:true,
        },
    });

    if(!institution){
        throw new Error("Institution not found");
    }

    return institution;
}

export const updateInstitution = async (id:string,data:any) => {
    return prisma.institution.update({
        where: {id},
        data,
    });
};

export const toggleInstitutionStatus = async (
    id:string,
    status : "ACTIVE" | "SUSPENDED"
) => {
    return prisma.institution.update({
        where: {id},
        data: {status},
    });
};

export const resendInvite = async (email:string) => {
    const user = await prisma.user.findUnique({
        where : {email}
    })

    if(!user){
        throw new Error("User not found");
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.invite.create({
        data:{
            email,
            token,
            role:"ADMIN",
            institutionId:user.institutionId!,
            expiresAt,
        },
    });

    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${token}`;

    await sendInviteEmail({
        to:user.email,
        inviteLink,
    });

    return {
        message:"Invite resent successfully",
    };
}
