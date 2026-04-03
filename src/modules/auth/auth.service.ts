import { prisma } from "../../utils/prisma";
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

export const verifyInvite = async (token: string) => {
    const invite = await prisma.invite.findUnique({
        where: { token },
        include: {
            institution: true,
        },
    });

    if (!invite) throw new Error("Invalid Invite");

    if (invite.isUsed) throw new Error("Invite already used");

    if (invite.expiresAt < new Date) {
        throw new Error("Invite has expired");
    }

    return {
        email: invite.email,
        institution: invite.institution.name,
    };
};

export const acceptInvite = async (token: string, password: string) => {
    const invite = await prisma.invite.findUnique({
        where: { token },
    });

    if (!invite) throw new Error("Invalid Invite");

    if (invite.isUsed) throw new Error("Invite already used");

    if (invite.expiresAt < new Date) {
        throw new Error("Invite has expired");
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.findUnique({
        where: {
            email: invite.email,
        }
    });

    if (!user) throw new Error("User not found");

    const result = await prisma.$transaction(async (tx) => {
        const updatedUser = await tx.user.update({
            where: {
                email: invite.email,
            },
            data: {
                password: hashedPassword,
                isActive: true,
            },
        });

        await tx.invite.update({
            where: {
                id: invite.id,
            },
            data: {
                isUsed: true,
            },
        });
        return updatedUser;
    });

    const tokenJWT = jwt.sign(
        {
            userId: result.id,
            role: result.role,
            institutionId: result.institutionId,
        },
        JWT_SECRET,
        {
            expiresIn: "7d",
        }
    );
    return { token: tokenJWT };
};

export const login = async (email: string, password: string) => {
    const user = await prisma.user.findUnique({
        where: { email },
    });

    if (!user) throw new Error("User not found");

    if (!user.isActive) throw new Error("Account is not Active");

    const isMatch = await bcrypt.compare(password, user.password!);

    if (!isMatch) throw new Error("Invalid credentials");

    const token = jwt.sign({
        userId: user.id,
        role: user.role,
        institutionId: user.institutionId,
    },
        JWT_SECRET, {
        expiresIn: "7d",
    }
    );
    return { token };
}