"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendInviteEmail = void 0;
const resend_1 = require("resend");
const resend = new resend_1.Resend(process.env.RESEND_API_KEY);
const sendInviteEmail = async ({ to, name, inviteLink, }) => {
    try {
        const { data, error } = await resend.emails.send({
            from: "QubeEx: An AI Powered SAS Platform <support@qubeex.in>",
            to,
            subject: "You're invited to Qubeex",
            html: `
        <h2>Hello ${name || ""}</h2>
        <p>You’ve been invited as an Admin.</p>
        <p>Click below to activate your account:</p>
        <a href="${inviteLink}" style="padding:10px 16px;background:#000;color:#fff;text-decoration:none;">
          Activate Account
        </a>
        <p>This link expires in 24 hours.</p>
      `,
        });
        console.log("RESEND DATA:", data);
        console.log("RESEND ERROR:", error);
    }
    catch (error) {
        console.error("Email send failed", error);
        throw new Error("Failed to send invite email");
    }
};
exports.sendInviteEmail = sendInviteEmail;
