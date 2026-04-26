import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendInviteEmail = async ({
    to,
    name,
    inviteLink,
    institutionCode,
}: {
    to: string;
    name?: string;
    inviteLink: string;
    institutionCode?: string;
}) => {
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: "You're invited to QubeEx — Set up your Admin account",
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QubeEx Invite</title>
</head>
<body style="margin:0;padding:0;background:#0F0A1E;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0A1E;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1A112E;border-radius:20px;overflow:hidden;border:1px solid rgba(124,58,237,0.2);">

          <!-- Gradient header bar -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#7C3AED,#DA7756);"></td>
          </tr>

          <!-- Logo + brand -->
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <p style="margin:0;font-size:26px;font-weight:700;color:#FAE5D9;letter-spacing:-0.5px;">QubeEx</p>
              <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;">AI-Powered School Platform</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 16px;font-size:22px;font-weight:600;color:#fff;">
                Hello${name ? `, ${name}` : ''}! 👋
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                You have been invited as an <strong style="color:#DA7756;">Admin</strong> on the QubeEx platform. 
                Click the button below to set your password and activate your account.
              </p>

              ${institutionCode ? `
              <!-- Institution Code Box -->
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                <tr>
                  <td style="background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.3);border-radius:12px;padding:16px 20px;">
                    <p style="margin:0 0 4px;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1.5px;text-transform:uppercase;">Your Institution ID</p>
                    <p style="margin:0;font-size:22px;font-weight:700;color:#DA7756;letter-spacing:2px;font-family:monospace;">${institutionCode}</p>
                    <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">Keep this safe — you'll need it to complete setup and to log in.</p>
                  </td>
                </tr>
              </table>
              ` : ''}

              <p style="margin:0 0 28px;font-size:13px;color:rgba(255,255,255,0.35);">
                This link expires in <strong style="color:rgba(255,255,255,0.55);">24 hours</strong>.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td align="center" style="border-radius:12px;background:linear-gradient(135deg,#E8876A,#DA7756,#C06040);">
                    <a href="${inviteLink}"
                      style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;border-radius:12px;letter-spacing:0.2px;">
                      Activate My Account →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link -->
              <p style="margin:0 0 6px;font-size:12px;color:rgba(255,255,255,0.3);">Or copy this link into your browser:</p>
              <p style="margin:0;font-size:11px;color:#7C3AED;word-break:break-all;">${inviteLink}</p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background:rgba(255,255,255,0.07);"></div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 40px 32px;">
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);">
                This invite was sent via QubeEx. If you weren't expecting this, you can safely ignore it.
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,0.15);">
                © ${new Date().getFullYear()} QubeEx. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`,
        });

        if (error) {
            console.error('Resend error:', error);
        } else {
            console.log('Invite email sent:', data?.id);
        }
    } catch (err) {
        console.error('Email send failed:', err);
        throw new Error('Failed to send invite email');
    }
};