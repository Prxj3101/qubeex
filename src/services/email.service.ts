import { Resend } from 'resend';
import { formatExpiryLabel, ADMIN_INVITE_EXPIRY_MS, TEACHER_INVITE_EXPIRY_MS, SUBADMIN_INVITE_EXPIRY_MS } from '../utils/token';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendActivationEmail = async ({
    to,
    institutionName,
    planName,
    activationDate,
    nextBillingDate,
    discountPct,
    invoiceId,
    invoiceAmount,
    licenseFee,
    discountAmount,
}: {
    to: string;
    institutionName: string;
    planName: string;
    activationDate: Date;
    nextBillingDate: Date;
    discountPct: number;
    invoiceId: string;
    invoiceAmount: number;
    licenseFee: number;
    discountAmount: number;
}) => {
    const formatDate = (d: Date) =>
        d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

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
                      ${discountPct > 0 && discountAmount > 0 ? `
                      <tr>
                        <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
                          <p style="margin:0 0 3px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Discount Applied</p>
                          <p style="margin:0;font-size:14px;font-weight:600;color:#10B981;">${discountPct}% off licence fee (−₹${discountAmount.toLocaleString("en-IN")})</p>
                        </td>
                      </tr>` : ''}
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

        if (error) console.error('Resend error:', error);
        else console.log('Activation email sent:', data?.id);
    } catch (err) {
        console.error('Activation email send failed:', err);
    }
};

export const sendInviteEmail = async ({
    to,
    name,
    inviteLink,
    institutionName,
    institutionCode,
    userDisplayId,
    expiresInMs = ADMIN_INVITE_EXPIRY_MS,
}: {
    to: string;
    name?: string;
    inviteLink: string;
    institutionName?: string;
    institutionCode?: string;
    /** The invited Admin's own login ID (User.displayId) — usable in place of email at login. */
    userDisplayId?: string;
    /** Must match the duration actually used for this invite's `expiresAt`, so the copy below can never drift from what's really enforced. */
    expiresInMs?: number;
}) => {
    const expiryLabel = formatExpiryLabel(expiresInMs);
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
                You have been invited as an <strong style="color:#DA7756;">Admin</strong>${institutionName ? ` at <strong style="color:#fff;">${institutionName}</strong>` : ''} on the QubeEx platform.
                Click the button below to set your password and activate your account.
              </p>

              ${institutionCode ? `
              <!-- Institution Code Box -->
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:16px;">
                <tr>
                  <td style="background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.3);border-radius:12px;padding:16px 20px;">
                    <p style="margin:0 0 4px;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1.5px;text-transform:uppercase;">Your Institution ID</p>
                    <p style="margin:0;font-size:22px;font-weight:700;color:#DA7756;letter-spacing:2px;font-family:monospace;">${institutionCode}</p>
                    <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">Keep this safe — you'll need it to complete setup.</p>
                  </td>
                </tr>
              </table>
              ` : ''}

              ${userDisplayId ? `
              <!-- Admin User ID Box -->
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                <tr>
                  <td style="background:rgba(218,119,86,0.12);border:1px solid rgba(218,119,86,0.3);border-radius:12px;padding:16px 20px;">
                    <p style="margin:0 0 4px;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1.5px;text-transform:uppercase;">Your Admin ID</p>
                    <p style="margin:0;font-size:22px;font-weight:700;color:#DA7756;letter-spacing:2px;font-family:monospace;">${userDisplayId}</p>
                    <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">Use this (or your email) with your password to log in going forward.</p>
                  </td>
                </tr>
              </table>
              ` : ''}

              <p style="margin:0 0 28px;font-size:13px;color:rgba(255,255,255,0.35);">
                This link expires in <strong style="color:rgba(255,255,255,0.55);">${expiryLabel}</strong>.
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

export const sendTrialEndingEmail = async ({
  to,
  institutionName,
  daysRemaining,
  trialEndDate,
}: {
  to: string;
  institutionName: string;
  daysRemaining: number;
  trialEndDate: string;
}) => {
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

    if (error) console.error('Resend error (trial ending email):', error);
    else console.log('Trial ending email sent:', data?.id);
  } catch (err) {
    console.error('Trial ending email send failed:', err);
  }
};

export const sendSmartBoardFreeExpiryEmail = async ({
  to,
  institutionName,
  freeEndDate,
}: {
  to: string;
  institutionName: string;
  freeEndDate: string;
}) => {
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

    if (error) console.error('Resend error (smart board free expiry):', error);
    else console.log('Smart board free expiry email sent:', data?.id);
  } catch (err) {
    console.error('Smart board free expiry email send failed:', err);
  }
};

export const sendPayslipEmail = async ({
    to,
    staffName,
    institutionName,
    month,
    pdfBuffer,
}: {
    to: string;
    staffName: string;
    institutionName: string;
    month: string; // "2026-10"
    pdfBuffer: Buffer;
}) => {
    const monthLabel = (() => {
        const [y, m] = month.split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    })();

    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `Your payslip for ${monthLabel} — ${institutionName}`,
            html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0F0A1E;color:#fff;font-family:'Segoe UI',Arial,sans-serif;">
  <h2 style="margin:0 0 12px;">Your payslip is ready</h2>
  <p style="margin:0 0 10px;line-height:1.6;">
    Hi ${staffName}, your payslip for <strong>${monthLabel}</strong> from <strong>${institutionName}</strong> is attached to this email as a PDF.
  </p>
  <p style="margin:0;line-height:1.6;color:#aaa;font-size:13px;">
    This is an automated email — please contact your institution's admin office for any payroll queries.
  </p>
</body>
</html>`,
            attachments: [
                {
                    filename: `payslip-${month}.pdf`,
                    content: pdfBuffer,
                },
            ],
        });

        if (error) console.error('Resend error (payslip email):', error);
        else console.log('Payslip email sent:', data?.id);
    } catch (err) {
        console.error('Payslip email send failed:', err);
    }
};

export const sendMonthlyBillEmail = async ({
  to,
  institutionName,
  billingMonth,
  totalAmount,
  dueDate,
  billId,
  paymentLinkUrl,
}: {
  to: string;
  institutionName: string;
  billingMonth: string;
  totalAmount: number;
  dueDate: Date;
  billId: string;
  paymentLinkUrl?: string;
}) => {
  const formattedDueDate = dueDate.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

  const payNowButton = paymentLinkUrl
    ? `<p style="margin:16px 0 0;">
        <a href="${paymentLinkUrl}"
           style="display:inline-block;padding:10px 24px;background:#4F46E5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
          Pay Now
        </a>
       </p>`
    : "";

  try {
    const { data, error } = await resend.emails.send({
      from: 'QubeEx <support@qubeex.in>',
      to,
      subject: `Monthly Bill Generated — ₹${totalAmount.toLocaleString("en-IN")} due by ${formattedDueDate}`,
      html: `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#0f0f0f;color:#fff;padding:32px;">
  <h2 style="margin:0 0 12px;">Monthly Bill Generated</h2>
  <p style="margin:0 0 10px;line-height:1.6;">
    The QubeEx monthly bill for <strong>${institutionName}</strong> has been generated.
  </p>
  <p style="margin:0 0 8px;line-height:1.6;">Billing month: <strong>${billingMonth}</strong></p>
  <p style="margin:0 0 8px;line-height:1.6;">Bill ID: <strong>${billId}</strong></p>
  <p style="margin:0 0 8px;line-height:1.6;">Total amount due: <strong>₹${totalAmount.toLocaleString("en-IN")}</strong></p>
  <p style="margin:0;line-height:1.6;">Payment due by: <strong>${formattedDueDate}</strong></p>
  ${payNowButton}
</body>
</html>`,
    });

    if (error) console.error('Resend error (monthly bill):', error);
    else console.log('Monthly bill email sent:', data?.id);
  } catch (err) {
    console.error('Monthly bill email send failed:', err);
  }
};

export const sendPlanDowngradeEmail = async ({
  to,
  institutionName,
  storageWarning,
}: {
  to: string;
  institutionName: string;
  storageWarning: boolean;
}) => {
  const storageNote = storageWarning
    ? `<p style="margin:0 0 10px;line-height:1.6;color:#f59e0b;"><strong>⚠ Storage Warning:</strong> Your institution is using more than 500 GB. The Basic plan includes 500 GB. Please reduce your storage or purchase an extra storage add-on to avoid data access issues.</p>`
    : '';

  try {
    const { data, error } = await resend.emails.send({
      from: 'QubeEx <support@qubeex.in>',
      to,
      subject: `QubeEx: Your institution has been downgraded to Basic`,
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0F0A1E;color:#fff;font-family:'Segoe UI',Arial,sans-serif;">
  <h2 style="margin:0 0 12px;">Plan Downgraded to Basic</h2>
  <p style="margin:0 0 10px;line-height:1.6;">
    The QubeEx subscription for <strong>${institutionName}</strong> has been downgraded from <strong>PRO</strong> to <strong>Basic</strong>.
  </p>
  <p style="margin:0 0 10px;line-height:1.6;">
    PRO-exclusive features (Whitelabeling, Advanced Leaderboard, Student App Pro) have been disabled immediately. Your billing will reflect the Basic plan from next month onwards.
  </p>
  ${storageNote}
  <p style="margin:0;line-height:1.6;">If you have any questions, please contact QubeEx support.</p>
</body>
</html>`,
    });

    if (error) console.error('Resend error (plan downgrade):', error);
    else console.log('Plan downgrade email sent:', data?.id);
  } catch (err) {
    console.error('Plan downgrade email send failed:', err);
  }
};

export const sendTeacherInviteEmail = async ({
    to,
    name,
    inviteLink,
    institutionName,
    expiresInMs = TEACHER_INVITE_EXPIRY_MS,
}: {
    to: string;
    name?: string;
    inviteLink: string;
    institutionName: string;
    /** Must match the duration actually used for this invite's `expiresAt`, so the copy below can never drift from what's really enforced. */
    expiresInMs?: number;
}) => {
    const expiryLabel = formatExpiryLabel(expiresInMs);
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: "You're invited to QubeEx — Set up your Teacher account",
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QubeEx Teacher Invite</title>
</head>
<body style="margin:0;padding:0;background:#0F0A1E;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0A1E;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1A112E;border-radius:20px;overflow:hidden;border:1px solid rgba(124,58,237,0.2);">
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#7C3AED,#DA7756);"></td>
          </tr>
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <p style="margin:0;font-size:26px;font-weight:700;color:#FAE5D9;letter-spacing:-0.5px;">QubeEx</p>
              <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;">AI-Powered School Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 16px;font-size:22px;font-weight:700;color:#FAE5D9;">
                ${name ? `Hi ${name},` : 'Hello,'}
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:rgba(255,255,255,0.7);line-height:1.6;">
                You have been invited as a <strong style="color:#DA7756;">Teacher</strong> at <strong style="color:#FAE5D9;">${institutionName}</strong> on the QubeEx platform.
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:rgba(255,255,255,0.7);line-height:1.6;">
                Click the button below to set up your account and get started.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td align="center" style="border-radius:12px;background:linear-gradient(135deg,#DA7756,#C06040);">
                    <a href="${inviteLink}"
                       style="display:block;padding:14px 36px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;letter-spacing:0.3px;">
                      Set Up My Account
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:12px;color:rgba(255,255,255,0.3);text-align:center;">
                Link expires in ${expiryLabel}. If you weren't expecting this, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });

        if (error) {
            console.error('Teacher invite email error:', error);
            throw new Error('Failed to send teacher invite email');
        }

        console.log('Teacher invite email sent:', data?.id);
    } catch (err) {
        console.error('sendTeacherInviteEmail failed:', err);
        throw new Error('Failed to send teacher invite email');
    }
};

// Was previously a one-off design (solid #1A1535 card, purple button, plain
// <ul> permissions list, no logo/footer) — brought in line with the shared
// QubeEx account-email template (see sendInviteEmail / sendTeacherInviteEmail):
// same gradient header bar, logo block, orange CTA gradient, and
// divider+footer close. Content (name, institution, permissions, invite link)
// is unchanged — only the markup/styling around it.
export const sendSubAdminInviteEmail = async ({
    to,
    name,
    inviteLink,
    institutionName,
    permissions,
    expiresInMs = SUBADMIN_INVITE_EXPIRY_MS,
}: {
    to: string;
    name?: string;
    inviteLink: string;
    institutionName: string;
    permissions: string[];
    /** Must match the duration actually used for this invite's `expiresAt`, so the copy below can never drift from what's really enforced. */
    expiresInMs?: number;
}) => {
    const expiryLabel = formatExpiryLabel(expiresInMs);
    const permissionLabels: Record<string, string> = {
        CAMPUS: 'Campus & Classes',
        FEES: 'Fees Management',
    };
    const grantedList = permissions
        .map(p => permissionLabels[p] ?? p)
        .map(p => `<li style="margin:0 0 8px;padding:0;list-style:none;font-size:14px;color:rgba(255,255,255,0.75);">✅&nbsp;&nbsp;${p}</li>`)
        .join('');

    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: "You're invited to QubeEx — Set up your Sub-Admin account",
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QubeEx SubAdmin Invite</title>
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
              <p style="margin:0 0 16px;font-size:22px;font-weight:700;color:#FAE5D9;">
                ${name ? `Hi ${name},` : 'Hello,'}
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                You have been added as a <strong style="color:#DA7756;">Sub-Admin</strong> at <strong style="color:#fff;">${institutionName}</strong> on the QubeEx platform.
              </p>

              <!-- Permissions box -->
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                <tr>
                  <td style="background:rgba(218,119,86,0.12);border:1px solid rgba(218,119,86,0.3);border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 10px;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Your Access Includes</p>
                    <ul style="margin:0;padding:0;">${grantedList}</ul>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:13px;color:rgba(255,255,255,0.35);">
                This link expires in <strong style="color:rgba(255,255,255,0.55);">${expiryLabel}</strong>.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td align="center" style="border-radius:12px;background:linear-gradient(135deg,#E8876A,#DA7756,#C06040);">
                    <a href="${inviteLink}"
                      style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;border-radius:12px;letter-spacing:0.2px;">
                      Set Up My Account →
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
            console.error('Resend error (subadmin invite email):', error);
            throw new Error('Failed to send subadmin invite email');
        }

        console.log('SubAdmin invite email sent:', data?.id);
    } catch (err) {
        console.error('sendSubAdminInviteEmail failed:', err);
        throw new Error('Failed to send subadmin invite email');
    }
};

// Demo requests must never fail to be stored just because the email
// provider is down, so both functions below swallow their own errors
// (mirrors sendMonthlyBillEmail/sendPlanDowngradeEmail) instead of throwing —
// the caller records whether the send succeeded but always keeps the lead.
export const sendDemoRequestNotificationEmail = async ({
    to,
    name,
    email,
    phone,
    institutionName,
    institutionType,
    studentCount,
    message,
    submittedAt,
}: {
    to: string;
    name: string;
    email: string;
    phone: string;
    institutionName: string;
    institutionType: string;
    studentCount?: number | null;
    message?: string | null;
    submittedAt: Date;
}): Promise<boolean> => {
    const formattedDate = submittedAt.toLocaleString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
    });

    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `New Demo Request — ${institutionName}`,
            html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#0F0A1E;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0A1E;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1A112E;border-radius:20px;overflow:hidden;border:1px solid rgba(124,58,237,0.2);">
          <tr><td style="height:4px;background:linear-gradient(90deg,#7C3AED,#DA7756);"></td></tr>
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <p style="margin:0;font-size:26px;font-weight:700;color:#FAE5D9;letter-spacing:-0.5px;">QubeEx</p>
              <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;">New Demo Request</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                A new demo request came in from the landing page.
              </p>
              <table cellpadding="0" cellspacing="0" width="100%" style="background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.2);border-radius:12px;padding:4px 0;margin-bottom:20px;">
                <tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Name</p><p style="margin:2px 0 0;font-size:14px;color:#fff;">${name}</p></td></tr>
                <tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Email</p><p style="margin:2px 0 0;font-size:14px;color:#fff;">${email}</p></td></tr>
                <tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Phone</p><p style="margin:2px 0 0;font-size:14px;color:#fff;">${phone}</p></td></tr>
                <tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Institution</p><p style="margin:2px 0 0;font-size:14px;color:#fff;">${institutionName} (${institutionType})</p></td></tr>
                ${studentCount ? `<tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Students/Users</p><p style="margin:2px 0 0;font-size:14px;color:#fff;">${studentCount}</p></td></tr>` : ''}
                ${message ? `<tr><td style="padding:10px 20px;"><p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;">Message</p><p style="margin:2px 0 0;font-size:14px;color:#fff;line-height:1.5;">${message}</p></td></tr>` : ''}
              </table>
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);">Submitted ${formattedDate} IST</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });

        if (error) {
            console.error('Resend error (demo request notification):', error);
            return false;
        }
        console.log('Demo request notification email sent:', data?.id);
        return true;
    } catch (err) {
        console.error('Demo request notification email send failed:', err);
        return false;
    }
};

export const sendDemoRequestConfirmationEmail = async ({
    to,
    name,
}: {
    to: string;
    name: string;
}): Promise<boolean> => {
    const firstName = name.split(' ')[0] || 'there';
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: "We've received your QubeEx demo request",
            html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
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
              <p style="margin:0 0 16px;font-size:22px;font-weight:600;color:#fff;">Thanks, ${firstName}! 🎉</p>
              <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.65);line-height:1.6;">
                We've received your demo request and our team will reach out within
                <strong style="color:#DA7756;">24 hours</strong> to schedule your walkthrough.
              </p>
              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.35);">
                In the meantime, if you have any questions, just reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });

        if (error) {
            console.error('Resend error (demo request confirmation):', error);
            return false;
        }
        console.log('Demo request confirmation email sent:', data?.id);
        return true;
    } catch (err) {
        console.error('Demo request confirmation email send failed:', err);
        return false;
    }
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

// One template for every admissions email a parent gets (form received,
// interaction slot, offer, admission confirmed, login details). Text is passed
// in already written; this only escapes and lays it out. Sent in the school's
// own name, with a soft school-themed look like the parents' form.
const ADMISSION_TONES = {
    info: { bg: '#FFF1EA', fg: '#B4532F', emoji: '📝' },
    good: { bg: '#DCFCE7', fg: '#15803D', emoji: '🎉' },
    wait: { bg: '#FEF3C7', fg: '#B45309', emoji: '⏳' },
    blue: { bg: '#DBEAFE', fg: '#1D4ED8', emoji: '📅' },
    plain: { bg: '#F1F5F9', fg: '#475569', emoji: '✉️' },
} as const;

export const sendAdmissionEmail = async ({
    to,
    schoolName,
    logoUrl,
    subject,
    badge,
    tone = 'info',
    heading,
    lines,
    facts = [],
    note,
    noteLabel = 'NOTE',
    link,
    linkLabel,
    extraLink,
}: {
    to: string;
    schoolName: string;
    logoUrl?: string | null;
    subject: string;
    /** Small label above the heading, e.g. "Application received". */
    badge?: string;
    tone?: keyof typeof ADMISSION_TONES;
    heading: string;
    lines: string[];
    /** Label / value rows shown in a box, e.g. the application number. */
    facts?: { label: string; value: string }[];
    /** A note from the school (e.g. "Bring 2 passport size photos"), shown highlighted. */
    note?: string;
    /** Word before the note, e.g. NOTE or REASON. */
    noteLabel?: string;
    link?: string;
    linkLabel?: string;
    /** A second, highlighted button above the status button (e.g. the admission form). */
    extraLink?: { url: string; label: string };
}) => {
    if (!to) return false;
    const t = ADMISSION_TONES[tone];
    const school = escapeHtml(schoolName);
    const logo = logoUrl && /^https:\/\//.test(logoUrl)
        ? `<img src="${escapeHtml(logoUrl)}" width="64" height="64" alt="${school}" style="display:block;margin:0 auto;width:64px;height:64px;object-fit:contain;border-radius:16px;background:#ffffff;border:1px solid #E2E8F0;" />`
        : `<div style="margin:0 auto;width:64px;height:64px;line-height:64px;border-radius:16px;background:#FFFFFF;font-size:30px;text-align:center;">🏫</div>`;
    const factRows = facts.map(f => `
              <tr>
                <td style="padding:7px 0;font-size:13px;color:#64748B;">${escapeHtml(f.label)}</td>
                <td style="padding:7px 0;font-size:14px;font-weight:700;color:#0F172A;text-align:right;">${escapeHtml(f.value)}</td>
              </tr>`).join('');
    try {
        const { error } = await resend.emails.send({
            from: `${schoolName.replace(/[<>"]/g, '')} <support@qubeex.in>`,
            to,
            subject,
            html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <style>
    :root { color-scheme: light dark; }
    /* Cream header and terracotta button look the same in light and dark mode;
       the green footer band turns deep green in dark mode. */
    @media (prefers-color-scheme: dark) {
      .adm-head { background-color: #F3E7D3 !important; }
      .adm-school { color: #3B2F22 !important; }
      .adm-sub { color: #8A6D45 !important; }
      .adm-btn { background-color: #C9663F !important; color: #FFFFFF !important; }
      .adm-curve { background-color: #1E4D33 !important; }
      .adm-foot { background-color: #163F2A !important; }
      .adm-foot-text { color: #BBF7D0 !important; }
      .adm-note { background-color: #3B1212 !important; }
      .adm-note-text, .adm-note-text strong { color: #FECACA !important; }
    }
    [data-ogsc] .adm-btn { color: #FFFFFF !important; }
    [data-ogsc] .adm-foot-text { color: #BBF7D0 !important; }
  </style>
</head>
<body style="margin:0;padding:0;background:#F3F7F6;font-family:'Segoe UI',Arial,sans-serif;color:#0F172A;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#F3F7F6;padding:28px 12px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #DCE9E6;">
        <tr>
          <td align="center" bgcolor="#FBF1DE" class="adm-head" style="background-color:#FBF1DE;padding:24px 24px 22px;border-bottom:1px solid #EFE2C8;">
            <div style="font-size:18px;letter-spacing:10px;margin-bottom:12px;">☀️ ☁️ ✏️ 📚</div>
            ${logo}
            <p class="adm-school" style="margin:12px 0 0;font-size:19px;font-weight:800;color:#3B2F22;">${school}</p>
            <p class="adm-sub" style="margin:3px 0 0;font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9A7B4F;">Admissions</p>
          </td>
        </tr>
        <tr>
          <td style="padding:26px 28px 8px;">
            ${badge ? `<span style="display:inline-block;background:${t.bg};color:${t.fg};font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">${t.emoji} ${escapeHtml(badge)}</span>` : ''}
            <h2 style="margin:12px 0 14px;font-size:22px;line-height:1.3;color:#0F172A;">${escapeHtml(heading)}</h2>
            ${lines.map(line => `<p style="margin:0 0 10px;line-height:1.65;font-size:15px;color:#334155;">${escapeHtml(line)}</p>`).join('')}
            ${note ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:6px 0 4px;"><tr><td bgcolor="#FEF2F2" class="adm-note" style="background-color:#FEF2F2;border-left:4px solid #DC2626;border-radius:10px;padding:12px 14px;">
              <p class="adm-note-text" style="margin:0;font-size:15px;line-height:1.5;color:#7F1D1D;"><span style="color:#DC2626;font-weight:800;">*</span> <strong style="color:#B91C1C;letter-spacing:0.5px;">${escapeHtml(noteLabel)}:</strong> <strong>${escapeHtml(note)}</strong></p>
            </td></tr></table>` : ''}
          </td>
        </tr>
        ${factRows ? `
        <tr>
          <td style="padding:6px 28px 4px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#F8FAFC;border:1px dashed #CBD5E1;border-radius:16px;padding:8px 16px;">
              ${factRows}
            </table>
          </td>
        </tr>` : ''}
        ${extraLink ? `
        <tr>
          <td align="center" style="padding:22px 28px 0;">
            <a href="${escapeHtml(extraLink.url)}" class="adm-btn" style="display:inline-block;background-color:#DA7756;color:#FFFFFF;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:14px;font-size:15px;">${escapeHtml(extraLink.label)} &rarr;</a>
          </td>
        </tr>` : ''}
        ${link ? `
        <tr>
          <td align="center" style="padding:22px 28px 6px;">
            <a href="${escapeHtml(link)}" class="adm-btn" style="display:inline-block;background-color:#DA7756;color:#FFFFFF;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:14px;font-size:15px;">${escapeHtml(linkLabel || 'Open')} &rarr;</a>
            <p style="margin:10px 0 0;font-size:12px;color:#94A3B8;">Keep this email. The button always shows the latest status.</p>
          </td>
        </tr>` : ''}
        <tr>
          <td style="padding:22px 0 0;">
            <div class="adm-curve" style="background-color:#BBF7D0;height:10px;border-radius:50% 50% 0 0 / 100% 100% 0 0;"></div>
            <div class="adm-foot" style="background-color:#86EFAC;padding:14px 24px 18px;text-align:center;">
              <div style="font-size:16px;letter-spacing:8px;margin-bottom:6px;">🌳 🚌 🎒 🏫 🌼</div>
              <p class="adm-foot-text" style="margin:0;font-size:12px;color:#14532D;line-height:1.5;">This is an automated email from ${school}. For any question, please contact the school office.</p>
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
        });
        if (error) { console.error('Resend error (admission email):', error); return false; }
        return true;
    } catch (err) {
        console.error('Admission email send failed:', err);
        return false;
    }
};

export const sendLibraryReminderEmail = async ({
    to,
    name,
    institutionName,
    items,
}: {
    to: string;
    name: string;
    institutionName: string;
    items: { title: string; dueLabel: string; overdue: boolean }[];
}) => {
    const rows = items
        .map((i) => `<li style="margin:0 0 6px;"><strong>${escapeHtml(i.title)}</strong> — ${escapeHtml(i.dueLabel)}${i.overdue ? ' <span style="color:#ff8a8a;">(overdue)</span>' : ''}</li>`)
        .join('');
    try {
        const { data, error } = await resend.emails.send({
            from: 'QubeEx <support@qubeex.in>',
            to,
            subject: `Library books to return — ${institutionName}`,
            html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0F0A1E;color:#fff;font-family:'Segoe UI',Arial,sans-serif;">
  <h2 style="margin:0 0 12px;">Library reminder</h2>
  <p style="margin:0 0 10px;line-height:1.6;">Hi ${escapeHtml(name)}, please return these books to the ${escapeHtml(institutionName)} library:</p>
  <ul style="margin:0 0 14px;padding-left:20px;line-height:1.6;">${rows}</ul>
  <p style="margin:0;line-height:1.6;color:#aaa;font-size:13px;">This is an automated reminder. Contact the library if you have already returned these books.</p>
</body>
</html>`,
        });
        if (error) console.error('Resend error (library reminder):', error);
        else console.log('Library reminder email sent:', data?.id);
    } catch (err) {
        console.error('Library reminder email failed:', err);
    }
};
