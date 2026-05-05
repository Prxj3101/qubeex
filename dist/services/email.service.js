"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMonthlyBillEmail = exports.sendSmartBoardFreeExpiryEmail = exports.sendTrialEndingEmail = exports.sendInviteEmail = exports.sendActivationEmail = void 0;
const resend_1 = require("resend");
const resend = new resend_1.Resend(process.env.RESEND_API_KEY);
const sendActivationEmail = async ({ to, institutionName, planName, activationDate, nextBillingDate, discountPct, invoiceId, invoiceAmount, licenseFee, discountAmount, }) => {
    const formatDate = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `Your ${planName} plan is now active — Welcome to QubeEx!`,
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#0F0A1E;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0A1E;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1A112E;border-radius:20px;overflow:hidden;border:1px solid rgba(124,58,237,0.2);">
          <tr><td style="height:4px;background:linear-gradient(90deg,#7C3AED,#DA7756);"></td></tr>
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <p style="margin:0;font-size:26px;font-weight:700;color:#FAE5D9;letter-spacing:-0.5px;">QubeEx</p>
              <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;">AI-Powered School Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 16px;font-size:22px;font-weight:600;color:#fff;">Plan Activated!</p>
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                <strong style="color:#fff;">${institutionName}</strong> is now live on the
                <strong style="color:#DA7756;">${planName}</strong> plan.
                Your institution now has full access to all ${planName} features.
              </p>

              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                <tr>
                  <td style="background:rgba(218,119,86,0.12);border:1px solid rgba(218,119,86,0.3);border-radius:12px;padding:20px 24px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Plan</p>
                          <p style="margin:0;font-size:16px;font-weight:700;color:#DA7756;">${planName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Activation Date</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#fff;">${formatDate(activationDate)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">First Bill Date</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#fff;">${formatDate(nextBillingDate)}</p>
                        </td>
                      </tr>
                      ${discountPct > 0 ? `
                      <tr>
                        <td style="padding-top:12px;">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Discount Applied</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#10B981;">${discountPct}% off licence fee</p>
                        </td>
                      </tr>` : '<tr><td style="padding-top:12px;"></td></tr>'}
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Invoice ID</p>
                          <p style="margin:0;font-size:13px;font-weight:600;color:#fff;font-family:monospace;">${invoiceId}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Licence Fee</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#fff;">₹${licenseFee.toLocaleString("en-IN")}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Discount Amount</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#10B981;">₹${discountAmount.toLocaleString("en-IN")}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:12px;">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Paid Amount</p>
                          <p style="margin:0;font-size:16px;font-weight:700;color:#DA7756;">₹${invoiceAmount.toLocaleString("en-IN")}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.4);line-height:1.6;">
                Per-user billing starts from your activation date. Your first bill will be generated on
                <strong style="color:rgba(255,255,255,0.6);">${formatDate(nextBillingDate)}</strong> and
                payment is due by the 7th of the following month.
              </p>
            </td>
          </tr>
          <tr><td style="padding:0 40px;"><div style="height:1px;background:rgba(255,255,255,0.07);"></div></td></tr>
          <tr>
            <td align="center" style="padding:24px 40px 32px;">
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);">
                This is an automated confirmation from QubeEx.
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,0.15);">© ${new Date().getFullYear()} QubeEx. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });
        if (error)
            console.error('Resend error:', error);
        else
            console.log('Activation email sent:', data?.id);
    }
    catch (err) {
        console.error('Activation email send failed:', err);
    }
};
exports.sendActivationEmail = sendActivationEmail;
const sendInviteEmail = async ({ to, name, inviteLink, institutionCode, }) => {
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
        }
        else {
            console.log('Invite email sent:', data?.id);
        }
    }
    catch (err) {
        console.error('Email send failed:', err);
        throw new Error('Failed to send invite email');
    }
};
exports.sendInviteEmail = sendInviteEmail;
const sendTrialEndingEmail = async ({ to, institutionName, daysRemaining, trialEndDate, }) => {
    const dayWord = daysRemaining === 1 ? 'day' : 'days';
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `Your QubeEx trial ends in ${daysRemaining} ${dayWord}`,
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#0F0A1E;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0A1E;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1A112E;border-radius:20px;overflow:hidden;border:1px solid rgba(124,58,237,0.2);">
          <tr><td style="height:4px;background:linear-gradient(90deg,#7C3AED,#DA7756);"></td></tr>
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <p style="margin:0;font-size:26px;font-weight:700;color:#FAE5D9;letter-spacing:-0.5px;">QubeEx</p>
              <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;">AI-Powered School Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 16px;font-size:22px;font-weight:600;color:#fff;">Your trial is ending soon</p>
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                The trial for <strong style="color:#fff;">${institutionName}</strong> ends in
                <strong style="color:#DA7756;">${daysRemaining} ${dayWord}</strong> on ${trialEndDate}.
              </p>

              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                <tr>
                  <td style="background:rgba(218,119,86,0.12);border:1px solid rgba(218,119,86,0.3);border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#DA7756;">What happens when the trial ends?</p>
                    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.6);line-height:1.6;">
                      If no plan is activated within <strong style="color:#fff;">24 hours</strong> of your trial expiry,
                      your institution will be automatically locked. All data is preserved and access
                      can be restored at any time by activating a plan.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">
                To continue without interruption, contact your QubeEx administrator to activate your plan before ${trialEndDate}.
              </p>
            </td>
          </tr>
          <tr><td style="padding:0 40px;"><div style="height:1px;background:rgba(255,255,255,0.07);"></div></td></tr>
          <tr>
            <td align="center" style="padding:24px 40px 32px;">
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);">
                This is an automated reminder from QubeEx.
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,0.15);">© ${new Date().getFullYear()} QubeEx. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });
        if (error)
            console.error('Resend error (trial ending email):', error);
        else
            console.log('Trial ending email sent:', data?.id);
    }
    catch (err) {
        console.error('Trial ending email send failed:', err);
    }
};
exports.sendTrialEndingEmail = sendTrialEndingEmail;
const sendSmartBoardFreeExpiryEmail = async ({ to, institutionName, freeEndDate, }) => {
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: "Smart Board + AI free period ends in 30 days",
            html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0F0A1E;color:#fff;font-family:'Segoe UI',Arial,sans-serif;">
  <h2 style="margin:0 0 12px;">Smart Board + AI Free Period Reminder</h2>
  <p style="margin:0 0 10px;line-height:1.6;">
    The first-year free Smart Board + AI addon period for <strong>${institutionName}</strong>
    will end on <strong>${freeEndDate}</strong>.
  </p>
  <p style="margin:0;line-height:1.6;">
    After this date, addon billing will apply based on the configured monthly or yearly price unless the addon is deactivated.
  </p>
</body>
</html>`,
        });
        if (error)
            console.error('Resend error (smart board free expiry):', error);
        else
            console.log('Smart board free expiry email sent:', data?.id);
    }
    catch (err) {
        console.error('Smart board free expiry email send failed:', err);
    }
};
exports.sendSmartBoardFreeExpiryEmail = sendSmartBoardFreeExpiryEmail;
const sendMonthlyBillEmail = async ({ to, institutionName, billingMonth, totalAmount, dueDate, billId, }) => {
    const formattedDueDate = dueDate.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
    });
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `QubeEx bill generated for ${billingMonth}`,
            html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0F0A1E;color:#fff;font-family:'Segoe UI',Arial,sans-serif;">
  <h2 style="margin:0 0 12px;">Monthly Bill Generated</h2>
  <p style="margin:0 0 10px;line-height:1.6;">
    The QubeEx monthly bill for <strong>${institutionName}</strong> has been generated.
  </p>
  <p style="margin:0 0 8px;line-height:1.6;">Billing month: <strong>${billingMonth}</strong></p>
  <p style="margin:0 0 8px;line-height:1.6;">Bill ID: <strong>${billId}</strong></p>
  <p style="margin:0 0 8px;line-height:1.6;">Total amount due: <strong>Rs.${totalAmount.toLocaleString("en-IN")}</strong></p>
  <p style="margin:0;line-height:1.6;">Payment due by: <strong>${formattedDueDate}</strong></p>
</body>
</html>`,
        });
        if (error)
            console.error('Resend error (monthly bill):', error);
        else
            console.log('Monthly bill email sent:', data?.id);
    }
    catch (err) {
        console.error('Monthly bill email send failed:', err);
    }
};
exports.sendMonthlyBillEmail = sendMonthlyBillEmail;
