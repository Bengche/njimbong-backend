/**
 * email.js
 * SendGrid email service for Njimbong Marketplace.
 *
 * All emails are sent from support@njimbong.com.
 * Templates are fully responsive, mobile-first HTML.
 * Every exported function is fire-and-forget safe — it logs errors
 * but never throws, so a mail failure never breaks a request.
 */

import sgMail from "@sendgrid/mail";

const FROM = "Njimbong <support@njimbong.com>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "support@njimbong.com";
const APP_URL =
  process.env.FRONTEND_URL?.split(",")[0].trim() || "https://njimbong.com";

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn("[Email] SENDGRID_API_KEY is not set. Emails will not be sent.");
}

// ─── Shared layout ────────────────────────────────────────────────────────────

const wrap = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; }
    .wrapper { max-width: 600px; margin: 40px auto; padding: 0 16px 40px; }
    .card { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #16a34a 0%, #065f46 100%); padding: 32px 40px; text-align: center; }
    .header img { height: 48px; width: 48px; border-radius: 10px; }
    .header-brand { color: #ffffff; font-size: 22px; font-weight: 700; margin-top: 12px; letter-spacing: -0.3px; }
    .body { padding: 40px; }
    .greeting { font-size: 20px; font-weight: 600; color: #18181b; margin-bottom: 16px; }
    .text { font-size: 15px; line-height: 1.65; color: #3f3f46; margin-bottom: 16px; }
    .btn { display: inline-block; background: #16a34a; color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 15px; font-weight: 600; margin: 8px 0 24px; }
    .btn-outline { display: inline-block; border: 1.5px solid #d1d5db; color: #374151 !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500; margin: 4px 0 24px; }
    .divider { border: none; border-top: 1px solid #e4e4e7; margin: 28px 0; }
    .meta { font-size: 13px; color: #71717a; line-height: 1.6; }
    .meta a { color: #16a34a; text-decoration: none; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    .badge-amber { background: #fef3c7; color: #92400e; }
    .info-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .info-box-red { background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .info-box-amber { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .info-row { display: flex; gap: 8px; margin-bottom: 8px; font-size: 14px; }
    .info-label { color: #71717a; min-width: 110px; flex-shrink: 0; }
    .info-value { color: #18181b; font-weight: 500; word-break: break-all; }
    .footer { text-align: center; padding: 24px 40px; }
    .footer-text { font-size: 12px; color: #a1a1aa; line-height: 1.6; }
    .footer-text a { color: #a1a1aa; text-decoration: underline; }
    @media (max-width: 480px) {
      .body { padding: 28px 24px; }
      .header { padding: 28px 24px; }
      .footer { padding: 20px 24px; }
    }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="header">
      <img src="${APP_URL}/icon-192x192.png" alt="Njimbong"/>
      <div class="header-brand">Njimbong</div>
    </div>
    <div class="body">
      ${body}
    </div>
  </div>
  <div class="footer">
    <p class="footer-text">
      This email was sent by Njimbong Marketplace &mdash; The Trusted Marketplace in Cameroon.<br/>
      <a href="${APP_URL}">njimbong.com</a> &middot; <a href="mailto:support@njimbong.com">support@njimbong.com</a>
    </p>
  </div>
</div>
</body>
</html>`;

// ─── Internal send helper ─────────────────────────────────────────────────────

async function send({ to, subject, html }) {
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    await sgMail.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(
      `[Email] Failed to send "${subject}" to ${to}:`,
      err?.response?.body || err.message,
    );
  }
}

// ─── 1. Email verification ────────────────────────────────────────────────────

export async function sendEmailVerification(user, token) {
  const link = `${APP_URL}/verify-email?token=${token}`;
  const html = wrap(
    "Verify your email — Njimbong",
    `
    <p class="greeting">Verify your email address</p>
    <p class="text">Thank you for joining Njimbong. Before you can start buying and selling, please verify your email address by clicking the button below.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${link}" class="btn">Verify Email Address</a>
    </p>
    <p class="text">This link expires in <strong>24 hours</strong>. If you did not create an account, you can safely ignore this email.</p>
    <hr class="divider"/>
    <p class="meta">If the button does not work, copy and paste this link into your browser:<br/>
      <a href="${link}">${link}</a>
    </p>
  `,
  );
  await send({
    to: user.email,
    subject: "Verify your email address — Njimbong",
    html,
  });
}

// ─── 2. Welcome email (sent after verification) ───────────────────────────────

export async function sendWelcomeEmail(user) {
  const html = wrap(
    "Welcome to Njimbong",
    `
    <p class="greeting">Welcome to Njimbong, ${user.name}.</p>
    <p class="text">Your email has been verified and your account is now active. You can now browse listings, buy securely through escrow, and sell your items to buyers across Cameroon.</p>
    <div class="info-box">
      <p style="font-size:14px;font-weight:600;color:#15803d;margin-bottom:10px;">Get started in three steps</p>
      <p style="font-size:14px;color:#374151;line-height:1.7;">
        1. Complete your <strong>profile</strong> — add a photo, bio, and location.<br/>
        2. Submit your <strong>KYC verification</strong> to unlock all platform features.<br/>
        3. Post your first <strong>listing</strong> and start selling.
      </p>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Go to your dashboard</a>
    </p>
    <hr class="divider"/>
    <p class="meta">If you have questions, contact us at <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "Welcome to Njimbong — your account is ready",
    html,
  });
}

// ─── 3. KYC submitted — notify admin ─────────────────────────────────────────

export async function sendKycSubmittedAdmin(user, kycId) {
  const reviewLink = `${APP_URL}/admin_dashboard/kyc`;
  const html = wrap(
    "New KYC submission — Njimbong Admin",
    `
    <p class="greeting">New KYC verification submitted</p>
    <p class="text">A user has submitted a KYC verification request and is awaiting review.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Name</span><span class="info-value">${user.name}</span></div>
      <div class="info-row"><span class="info-label">Username</span><span class="info-value">@${user.username}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span class="info-value">${user.email}</span></div>
      <div class="info-row"><span class="info-label">KYC ID</span><span class="info-value">#${kycId}</span></div>
      <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${new Date().toUTCString()}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewLink}" class="btn">Review in Admin Dashboard</a>
    </p>
  `,
  );
  await send({
    to: ADMIN_EMAIL,
    subject: `KYC submission from ${user.name} — action required`,
    html,
  });
}

// ─── 4. KYC approved — notify user ───────────────────────────────────────────

export async function sendKycApproved(user) {
  const html = wrap(
    "KYC Approved — Njimbong",
    `
    <p class="greeting">Your identity has been verified</p>
    <p class="text">Your KYC verification has been reviewed and <strong>approved</strong>. You are now a verified member of Njimbong.</p>
    <div class="info-box">
      <p style="font-size:14px;color:#374151;line-height:1.7;">
        As a verified user you can:<br/>
        &bull; Leave reviews on completed transactions.<br/>
        &bull; Display a verified badge on your profile and listings.<br/>
        &bull; Build trust with buyers and sellers across the platform.
      </p>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/profile" class="btn">View your profile</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Thank you for verifying your identity. If you have questions, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "Your KYC verification has been approved — Njimbong",
    html,
  });
}

// ─── 5. KYC rejected — notify user ───────────────────────────────────────────

export async function sendKycRejected(user, reason) {
  const html = wrap(
    "KYC Not Approved — Njimbong",
    `
    <p class="greeting">KYC verification not approved</p>
    <p class="text">Your KYC verification has been reviewed. Unfortunately we were unable to approve it at this time.</p>
    <div class="info-box-red">
      <p style="font-size:13px;font-weight:600;color:#b91c1c;margin-bottom:6px;">Reason provided by our team</p>
      <p style="font-size:14px;color:#374151;">${reason}</p>
    </div>
    <p class="text">You are welcome to correct the issue and resubmit your verification documents at any time.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/profile" class="btn">Resubmit verification</a>
    </p>
    <hr class="divider"/>
    <p class="meta">If you believe this decision is an error, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "Your KYC verification could not be approved — Njimbong",
    html,
  });
}

// ─── 6. New listing submitted — notify admin ──────────────────────────────────

export async function sendListingSubmittedAdmin(user, listing) {
  const reviewLink = `${APP_URL}/admin_dashboard/listings`;
  const html = wrap(
    "New listing pending review — Njimbong Admin",
    `
    <p class="greeting">New listing submitted for review</p>
    <p class="text">A seller has submitted a new listing and it is awaiting moderation approval.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Title</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Price</span><span class="info-value">${Number(listing.price).toLocaleString()} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Seller</span><span class="info-value">${user.name} (@${user.username})</span></div>
      <div class="info-row"><span class="info-label">Seller email</span><span class="info-value">${user.email}</span></div>
      <div class="info-row"><span class="info-label">Listing ID</span><span class="info-value">#${listing.id}</span></div>
      <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${new Date().toUTCString()}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewLink}" class="btn">Review in Admin Dashboard</a>
    </p>
  `,
  );
  await send({
    to: ADMIN_EMAIL,
    subject: `New listing pending review: "${listing.title}" — action required`,
    html,
  });
}

// ─── 7. Listing approved — notify user ───────────────────────────────────────

export async function sendListingApproved(user, listing) {
  const listingLink = `${APP_URL}/listing/${listing.id}`;
  const html = wrap(
    "Listing Approved — Njimbong",
    `
    <p class="greeting">Your listing has been approved</p>
    <p class="text">Your listing has been reviewed by our team and is now <strong>live on the marketplace</strong>. Buyers can now find and contact you.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Title</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Price</span><span class="info-value">${Number(listing.price).toLocaleString()} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Listing ID</span><span class="info-value">#${listing.id}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${listingLink}" class="btn">View your listing</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Share your listing with potential buyers to increase visibility. For support, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" is now live — Njimbong`,
    html,
  });
}

// ─── 8. Listing rejected — notify user ───────────────────────────────────────

export async function sendListingRejected(user, listing, reason) {
  const html = wrap(
    "Listing Not Approved — Njimbong",
    `
    <p class="greeting">Your listing could not be approved</p>
    <p class="text">Your listing has been reviewed and was not approved for publication on the marketplace.</p>
    <div class="info-box-red">
      <div class="info-row"><span class="info-label">Title</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row" style="margin-top:8px;"><span class="info-label">Reason</span><span class="info-value">${reason}</span></div>
    </div>
    <p class="text">Please update your listing to address the issue above and resubmit it for review.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Edit and resubmit</a>
    </p>
    <hr class="divider"/>
    <p class="meta">If you believe this decision is an error, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" was not approved — Njimbong`,
    html,
  });
}

// ─── 9. Account suspended — notify user ──────────────────────────────────────

export async function sendAccountSuspended(user, reason, endsAt) {
  const duration = endsAt
    ? `This suspension ends on <strong>${new Date(endsAt).toDateString()}</strong>.`
    : "This suspension is permanent pending further review.";
  const html = wrap(
    "Account Suspended — Njimbong",
    `
    <p class="greeting">Your account has been suspended</p>
    <p class="text">Your Njimbong account has been suspended following a review of your activity on the platform.</p>
    <div class="info-box-red">
      <p style="font-size:13px;font-weight:600;color:#b91c1c;margin-bottom:6px;">Reason</p>
      <p style="font-size:14px;color:#374151;">${reason}</p>
    </div>
    <p class="text">${duration}</p>
    <p class="text">If you wish to appeal this decision, please contact our support team with your account details and any relevant information.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="mailto:support@njimbong.com?subject=Suspension Appeal — ${encodeURIComponent(user.username)}" class="btn-outline">Contact Support to Appeal</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Njimbong reserves the right to suspend accounts that violate our <a href="${APP_URL}/terms-privacy">Terms of Service</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "Your Njimbong account has been suspended",
    html,
  });
}

// ─── 10. Account reinstated — notify user ────────────────────────────────────

export async function sendAccountReinstated(user) {
  const html = wrap(
    "Account Reinstated — Njimbong",
    `
    <p class="greeting">Your account has been reinstated</p>
    <p class="text">Following a review, your Njimbong account suspension has been lifted. You can now log in and use the platform again.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/login" class="btn">Log in to Njimbong</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Please review our <a href="${APP_URL}/terms-privacy">Terms of Service</a> to ensure continued compliance. For questions, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "Your Njimbong account has been reinstated",
    html,
  });
}

// ─── 11. Admin warning issued — notify user ───────────────────────────────────

export async function sendAdminWarning(user, reason, severity) {
  const html = wrap(
    "Account Warning — Njimbong",
    `
    <p class="greeting">A warning has been issued on your account</p>
    <p class="text">Our moderation team has issued a formal warning on your Njimbong account.</p>
    <div class="info-box-amber">
      <p style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:6px;">Warning details</p>
      <p style="font-size:14px;color:#374151;margin-bottom:6px;">${reason}</p>
      <p style="font-size:13px;color:#71717a;">Severity: <strong>${severity || "standard"}</strong></p>
    </div>
    <p class="text">Repeated violations may result in account suspension. Please review our community guidelines to avoid further action.</p>
    <hr class="divider"/>
    <p class="meta">Questions? Contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: "A warning has been issued on your Njimbong account",
    html,
  });
}

// ─── 12. Payment confirmed (escrow funded) — notify buyer + seller ────────────

export async function sendPaymentConfirmedBuyer(user, listing, orderId) {
  const formattedAmount = Number(listing.amount).toLocaleString("en-US");
  const dashboardLink = `${APP_URL}/dashboard`;
  const html = wrap(
    "Payment Secured in Escrow — Njimbong",
    `
    <p class="greeting">Your payment is held securely, ${user.name}.</p>
    <p class="text">Your payment has been confirmed and is now held safely in escrow. The seller has been notified and will prepare your item for delivery. Your funds are fully protected — they will not be released until you confirm receipt.</p>
    <div class="info-box">
      <p style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:12px;">Order Summary</p>
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Amount Paid</span><span class="info-value" style="font-size:15px;font-weight:700;color:#15803d;">${formattedAmount} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-green">Funds in Escrow</span></span></div>
    </div>
    <div class="info-box-amber">
      <p style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:10px;">What happens next?</p>
      <p style="font-size:14px;color:#374151;line-height:1.8;">
        1. The seller will contact you through Njimbong to arrange delivery.<br/>
        2. Inspect the item carefully upon receipt.<br/>
        3. Once you are satisfied, release the funds to the seller from your Njimbong dashboard.<br/>
        4. <strong>Do not release funds until you have received and inspected the item.</strong>
      </p>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${dashboardLink}" class="btn">Go to your Dashboard</a>
    </p>
    <hr class="divider"/>
    <p class="meta">If you have an issue with this order, contact us at <a href="mailto:support@njimbong.com">support@njimbong.com</a> quoting reference <strong>#${orderId}</strong>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your payment for "${listing.title}" is secured — Njimbong`,
    html,
  });
}

export async function sendPaymentConfirmedSeller(
  user,
  listing,
  orderId,
  amount,
  currency,
) {
  const formattedAmount = Number(amount).toLocaleString("en-US");
  const formattedNet = (Number(amount) * 0.98).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  const dashboardLink = `${APP_URL}/dashboard`;
  const html = wrap(
    "Your Item Has Been Paid For — Njimbong",
    `
    <p class="greeting">Congratulations, ${user.name} — your item has been paid for.</p>
    <p class="text">A buyer has successfully paid for your listing on Njimbong. The full payment is now held securely in escrow by Fonlok and is awaiting your delivery. Once the buyer confirms receipt, the funds will be sent directly to your registered Mobile Money number.</p>

    <div class="info-box">
      <p style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:12px;">Order Details</p>
      <div class="info-row"><span class="info-label">Item Sold</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Amount Paid</span><span class="info-value" style="font-size:16px;font-weight:700;color:#15803d;">${formattedAmount} ${currency}</span></div>
      <div class="info-row"><span class="info-label">You Will Receive</span><span class="info-value" style="font-weight:600;">≈ ${formattedNet} ${currency} <span style="font-size:12px;color:#71717a;">(after 3% Fonlok fee)</span></span></div>
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Escrow Status</span><span class="info-value"><span class="badge badge-green">Funds Secured</span></span></div>
    </div>

    <div class="info-box-amber">
      <p style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:10px;">Action Required — Please Deliver the Item</p>
      <p style="font-size:14px;color:#374151;line-height:1.8;">
        1. Contact the buyer through your Njimbong chat to arrange delivery.<br/>
        2. Deliver the item exactly as described in your listing.<br/>
        3. Once the buyer confirms receipt on Njimbong, the funds are automatically released to your Mobile Money number.<br/>
        4. <strong>Do not ask the buyer to release funds before they have received the item.</strong>
      </p>
    </div>

    <p class="text" style="color:#374151;">The buyer's payment of <strong>${formattedAmount} ${currency}</strong> is held securely by Fonlok. Fonlok will deduct their standard 2% platform fee at the time of payout, and the remaining <strong>≈ ${formattedNet} ${currency}</strong> will be sent directly to your Mobile Money number.</p>

    <p style="text-align:center;margin:28px 0;">
      <a href="${dashboardLink}" class="btn">View Order on Dashboard</a>
    </p>

    <hr class="divider"/>
    <p class="meta">If you have questions about this order or the payout process, contact us at <a href="mailto:support@njimbong.com">support@njimbong.com</a> with order reference <strong>#${orderId}</strong>.<br/>For disputes, email <a href="mailto:support@fonlok.com">support@fonlok.com</a> with the same reference.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" has been paid for — deliver now`,
    html,
  });
}

// ─── 13. Payout released — notify seller ─────────────────────────────────────

export async function sendPaymentReleasedSeller(
  user,
  listing,
  orderId,
  grossAmount,
  netAmount,
  fee,
  currency,
  reviewLink,
) {
  const fmtGross = Number(grossAmount).toLocaleString("en-US");
  const fmtNet = Number(netAmount).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  const fmtFee = Number(fee).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  const html = wrap(
    "Payout Sent to Your MoMo — Njimbong",
    `
    <p class="greeting">Your payout has been sent, ${user.name}.</p>
    <p class="text">The buyer has confirmed receipt of your item and the funds have been released from escrow. Your payment has been dispatched directly to your registered Mobile Money number.</p>

    <div class="info-box">
      <p style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:12px;">Payout Summary</p>
      <div class="info-row"><span class="info-label">Item Sold</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Gross Amount</span><span class="info-value">${fmtGross} ${currency}</span></div>
      <div class="info-row"><span class="info-label">Fonlok Fee (3%)</span><span class="info-value" style="color:#b91c1c;">− ${fmtFee} ${currency}</span></div>
      <div class="info-row" style="border-top:1px solid #bbf7d0;padding-top:10px;margin-top:6px;">
        <span class="info-label" style="font-weight:700;">You Received</span>
        <span class="info-value" style="font-size:18px;font-weight:800;color:#15803d;">${fmtNet} ${currency}</span>
      </div>
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-green">Payout Complete</span></span></div>
    </div>

    <p class="text">Please check your Mobile Money balance to confirm receipt of <strong>${fmtNet} ${currency}</strong>. If you do not see it within 24 hours, contact <a href="mailto:support@fonlok.com" style="color:#16a34a;">support@fonlok.com</a> with your order reference.</p>

    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="font-size:14px;font-weight:700;color:#0369a1;margin-bottom:8px;">Leave a Review for Your Buyer</p>
      <p style="font-size:14px;color:#374151;line-height:1.7;">Help build trust on Njimbong by sharing your experience with this buyer. Reviews are visible to the entire community.</p>
      <p style="text-align:center;margin-top:14px;">
        <a href="${reviewLink}" style="display:inline-block;background:#0369a1;color:#ffffff !important;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:600;">Leave a Review</a>
      </p>
    </div>

    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Go to your Dashboard</a>
    </p>

    <hr class="divider"/>
    <p class="meta">
      Thank you for selling on Njimbong. For payout questions, contact <a href="mailto:support@fonlok.com">support@fonlok.com</a>
      with reference <strong>#${orderId}</strong>.<br/>
      For platform support, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a>.
    </p>
  `,
  );
  await send({
    to: user.email,
    subject: `Payout of ${fmtNet} ${currency} sent for "${listing.title}" — Njimbong`,
    html,
  });
}

// ─── 14. Transaction complete — notify buyer ──────────────────────────────────

export async function sendPaymentReleasedBuyer(
  user,
  listing,
  orderId,
  amount,
  currency,
  reviewLink,
) {
  const fmtAmount = Number(amount).toLocaleString("en-US");
  const html = wrap(
    "Transaction Complete — Njimbong",
    `
    <p class="greeting">Transaction complete, ${user.name}.</p>
    <p class="text">You have confirmed receipt and the funds have been released to the seller. Your transaction is now fully complete. Thank you for using Njimbong's secure escrow service.</p>

    <div class="info-box">
      <p style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:12px;">Order Summary</p>
      <div class="info-row"><span class="info-label">Item Purchased</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Amount Paid</span><span class="info-value" style="font-size:15px;font-weight:700;color:#15803d;">${fmtAmount} ${currency}</span></div>
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-green">Complete</span></span></div>
    </div>

    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="font-size:14px;font-weight:700;color:#0369a1;margin-bottom:8px;">Share Your Experience</p>
      <p style="font-size:14px;color:#374151;line-height:1.7;">How was your experience with this seller? Your honest review helps other buyers make confident decisions and rewards trustworthy sellers on Njimbong.</p>
      <p style="text-align:center;margin-top:14px;">
        <a href="${reviewLink}" style="display:inline-block;background:#0369a1;color:#ffffff !important;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:600;">Review the Seller</a>
      </p>
    </div>

    <p style="text-align:center;margin:28px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Go to your Dashboard</a>
    </p>

    <hr class="divider"/>
    <p class="meta">Thank you for shopping on Njimbong. For any post-sale issues, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a> with reference <strong>#${orderId}</strong>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your purchase of "${listing.title}" is complete — Njimbong`,
    html,
  });
}

// ─── 15. New report submitted — notify admin ──────────────────────────────────

export async function sendReportSubmittedAdmin(report) {
  const reviewLink = `${APP_URL}/admin_dashboard/moderation`;
  const html = wrap(
    "New Report Submitted — Njimbong Admin",
    `
    <p class="greeting">A new report has been submitted</p>
    <div class="info-box-amber">
      <div class="info-row"><span class="info-label">Report type</span><span class="info-value">${report.report_type}</span></div>
      <div class="info-row"><span class="info-label">Reason</span><span class="info-value">${report.custom_reason || report.reason || "—"}</span></div>
      <div class="info-row"><span class="info-label">Priority</span><span class="info-value">${report.priority || 1}</span></div>
      <div class="info-row"><span class="info-label">Report ID</span><span class="info-value">#${report.id}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewLink}" class="btn">Review in Admin Dashboard</a>
    </p>
  `,
  );
  await send({
    to: ADMIN_EMAIL,
    subject: `New ${report.report_type} report submitted — action required`,
    html,
  });
}

// ─── 16. New offer received — notify seller ───────────────────────────────────

export async function sendOfferReceived(seller, listing, offer) {
  const dashLink = `${APP_URL}/listing/${listing.id}`;
  const fmtOffer = Number(offer.amount).toLocaleString("en-US");
  const fmtAsk = Number(listing.price).toLocaleString("en-US");
  const html = wrap(
    "New Offer Received — Njimbong",
    `
    <p class="greeting">You received an offer on your listing, ${seller.name}.</p>
    <p class="text">A buyer has made an offer on one of your listings. You can accept, counter, or decline from the listing page.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Your asking price</span><span class="info-value">${fmtAsk} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Offer amount</span><span class="info-value" style="font-size:16px;font-weight:700;color:#15803d;">${fmtOffer} ${listing.currency}</span></div>
      ${offer.message ? `<div class="info-row"><span class="info-label">Message</span><span class="info-value">${offer.message}</span></div>` : ""}
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${dashLink}" class="btn">View Offer</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Offers expire after 48 hours if not acted upon.</p>
  `,
  );
  await send({
    to: seller.email,
    subject: `New offer on "${listing.title}" — Njimbong`,
    html,
  });
}

// ─── 17. Offer accepted — notify buyer ───────────────────────────────────────

export async function sendOfferAccepted(buyer, listing, offer) {
  const listingLink = `${APP_URL}/listing/${listing.id}`;
  const fmtOffer = Number(offer.amount).toLocaleString("en-US");
  const html = wrap(
    "Your Offer Was Accepted — Njimbong",
    `
    <p class="greeting">Great news, ${buyer.name} — your offer was accepted!</p>
    <p class="text">The seller has accepted your offer. Complete your purchase now using Fonlok secure escrow to claim the item before it is released to other buyers.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Agreed price</span><span class="info-value" style="font-size:16px;font-weight:700;color:#15803d;">${fmtOffer} ${listing.currency}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${listingLink}" class="btn">Pay Now via Escrow</a>
    </p>
    <hr class="divider"/>
    <p class="meta">This agreed price is valid for 48 hours. After that the listing returns to full price.</p>
  `,
  );
  await send({
    to: buyer.email,
    subject: `Your offer on "${listing.title}" was accepted — Njimbong`,
    html,
  });
}

// ─── 18. Offer countered — notify buyer ──────────────────────────────────────

export async function sendOfferCountered(
  buyer,
  listing,
  originalAmount,
  counterAmount,
  currency,
) {
  const listingLink = `${APP_URL}/listing/${listing.id}`;
  const fmtOriginal = Number(originalAmount).toLocaleString("en-US");
  const fmtCounter = Number(counterAmount).toLocaleString("en-US");
  const html = wrap(
    "Counter-Offer Received — Njimbong",
    `
    <p class="greeting">${buyer.name}, the seller has countered your offer.</p>
    <p class="text">The seller has responded to your offer with a counter-offer. You can accept their counter-offer directly on the listing page.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Your offer</span><span class="info-value">${fmtOriginal} ${currency}</span></div>
      <div class="info-row"><span class="info-label">Seller counter-offer</span><span class="info-value" style="font-size:16px;font-weight:700;color:#d97706;">${fmtCounter} ${currency}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${listingLink}" class="btn">View Counter-Offer</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Counter-offers expire after 48 hours if not acted upon.</p>
  `,
  );
  await send({
    to: buyer.email,
    subject: `Counter-offer on "${listing.title}" — Njimbong`,
    html,
  });
}

// ─── 19. Saved search alert — notify user ────────────────────────────────────

export async function sendSavedSearchAlert(user, searchName, matches) {
  const marketLink = `${APP_URL}/market`;
  const listingItems = matches
    .slice(0, 5)
    .map((l) => {
      const price = Number(l.price).toLocaleString("en-US");
      const link = `${APP_URL}/listing/${l.id}`;
      return `<div style="border:1px solid #e4e4e7;border-radius:8px;padding:14px;margin-bottom:10px;">
      <p style="font-size:15px;font-weight:600;color:#18181b;margin-bottom:4px;"><a href="${link}" style="color:#18181b;text-decoration:none;">${l.title}</a></p>
      <p style="font-size:14px;color:#15803d;font-weight:700;margin-bottom:4px;">${price} ${l.currency}</p>
      <p style="font-size:13px;color:#71717a;">${l.city}, ${l.country}</p>
    </div>`;
    })
    .join("");
  const html = wrap(
    "New Listings Match Your Saved Search — Njimbong",
    `
    <p class="greeting">New listings match your saved search, ${user.name}.</p>
    <p class="text">We found <strong>${matches.length} new listing${matches.length > 1 ? "s" : ""}</strong> matching your saved search <strong>"${searchName}"</strong>.</p>
    ${listingItems}
    ${matches.length > 5 ? `<p style="font-size:13px;color:#71717a;text-align:center;margin-top:8px;">and ${matches.length - 5} more…</p>` : ""}
    <p style="text-align:center;margin:28px 0;">
      <a href="${marketLink}" class="btn">Browse All Listings</a>
    </p>
    <hr class="divider"/>
    <p class="meta">You are receiving this because you saved a search alert. You can manage your saved searches from your <a href="${APP_URL}/dashboard">dashboard</a>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `${matches.length} new listing${matches.length > 1 ? "s" : ""} match your saved search "${searchName}" — Njimbong`,
    html,
  });
}

// ─── 20. Listing expiry warning — notify seller ───────────────────────────────

export async function sendListingExpiryWarning(user, listing) {
  const renewLink = `${APP_URL}/dashboard`;
  const html = wrap(
    "Your Listing Is Expiring Soon — Njimbong",
    `
    <p class="greeting">${user.name}, your listing expires in 7 days.</p>
    <p class="text">Listings on Njimbong expire after 60 days to keep the marketplace fresh. Your listing below will be automatically deactivated in 7 days unless you renew it.</p>
    <div class="info-box-amber">
      <div class="info-row"><span class="info-label">Listing</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Price</span><span class="info-value">${Number(listing.price).toLocaleString("en-US")} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Expires</span><span class="info-value">${new Date(listing.expires_at || Date.now() + 7 * 24 * 60 * 60 * 1000).toDateString()}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${renewLink}" class="btn">Renew Listing</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Renewing is free and takes one click. Your listing returns to the top of search results.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" expires in 7 days — renew now`,
    html,
  });
}

// ─── 21. Listing expired — notify seller ─────────────────────────────────────

export async function sendListingExpired(user, listing) {
  const renewLink = `${APP_URL}/dashboard`;
  const html = wrap(
    "Your Listing Has Expired — Njimbong",
    `
    <p class="greeting">${user.name}, your listing has expired.</p>
    <p class="text">Your listing has been automatically deactivated after 60 days. You can renew it with one click to make it live again — it will appear as a fresh listing at the top of search results.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Listing</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Price</span><span class="info-value">${Number(listing.price).toLocaleString("en-US")} ${listing.currency}</span></div>
    </div>
    <a class="btn" href="${renewLink}">Renew Listing</a>
    <hr class="divider"/>
    <p class="meta">Renewing is free and takes one click. Your listing returns to the top of search results.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" has expired`,
    html,
  });
}

// ─── 22. Price drop alert — notify wishlist user ───────────────────────────────

export async function sendPriceDropAlert(user, listing, oldPrice, newPrice) {
  const listingLink = `${APP_URL}/listing/${listing.id}`;
  const drop = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
  const html = wrap(
    "Price Drop on Your Wishlist — Njimbong",
    `
    <p class="greeting">Good news, ${user.name}!</p>
    <p class="text">The price just dropped on an item you saved to your wishlist.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Old Price</span><span class="info-value">${Number(oldPrice).toLocaleString("en-US")} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">New Price</span><span class="info-value">${Number(newPrice).toLocaleString("en-US")} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Saving</span><span class="info-value">${drop}% off</span></div>
    </div>
    <a class="btn" href="${listingLink}">View Listing</a>
    <hr class="divider"/>
    <p class="meta">You saved this item to your wishlist. <a href="${APP_URL}/favorites">Manage wishlist</a></p>
  `,
  );
  await send({
    to: user.email,
    subject: `Price drop — "${listing.title}" is now ${Number(newPrice).toLocaleString("en-US")} ${listing.currency}`,
    html,
  });
}

// ─── 23. New listing from followed seller ─────────────────────────────────────

export async function sendNewListingFromFollowed(user, seller, listing) {
  const listingLink = `${APP_URL}/listing/${listing.id}`;
  const sellerLink = `${APP_URL}/profile/${seller.id}`;
  const html = wrap(
    `New Listing from ${seller.name} — Njimbong`,
    `
    <p class="greeting">Hey ${user.name},</p>
    <p class="text"><strong>${seller.name}</strong>, a seller you follow, just posted a new listing.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Item</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Price</span><span class="info-value">${Number(listing.price).toLocaleString("en-US")} ${listing.currency}</span></div>
      <div class="info-row"><span class="info-label">Location</span><span class="info-value">${listing.city}, ${listing.country}</span></div>
    </div>
    <a class="btn" href="${listingLink}">View Listing</a>
    <a class="btn-outline" href="${sellerLink}">View Seller Profile</a>
    <hr class="divider"/>
    <p class="meta">You're following ${seller.name}. <a href="${APP_URL}/profile/${seller.id}">Unfollow</a></p>
  `,
  );
  await send({
    to: user.email,
    subject: `${seller.name} just posted: "${listing.title}"`,
    html,
  });
}
    <p style="text-align:center;margin:28px 0;">
      <a href="${renewLink}" class="btn">Renew Listing Now</a>
    </p>
    <hr class="divider"/>
    <p class="meta">Renewal is free. Your listing will go back through standard moderation review.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Your listing "${listing.title}" has expired — renew to relist`,
    html,
  });
}

// ─── 22. Dispute filed — notify both parties + admin ─────────────────────────

export async function sendDisputeFiledToAdmin(
  disputer,
  listing,
  orderId,
  description,
) {
  const reviewLink = `${APP_URL}/admin_dashboard/moderation`;
  const html = wrap(
    "Dispute Filed — Njimbong Admin",
    `
    <p class="greeting">A dispute has been filed for an active escrow order.</p>
    <div class="info-box-red">
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Listing</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Filed by</span><span class="info-value">${disputer.name} (${disputer.email})</span></div>
      <div class="info-row"><span class="info-label">Description</span><span class="info-value">${description}</span></div>
      <div class="info-row"><span class="info-label">Filed at</span><span class="info-value">${new Date().toUTCString()}</span></div>
    </div>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewLink}" class="btn">Review Dispute</a>
    </p>
  `,
  );
  await send({
    to: ADMIN_EMAIL,
    subject: `Dispute filed — Order #${orderId} "${listing.title}" — action required`,
    html,
  });
}

// ─── Password reset ─────────────────────────────────────────────────────────

export async function sendPasswordResetEmail(user, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  const html = wrap(
    "Reset your password — Njimbong",
    `
    <p class="greeting">Reset your password</p>
    <p class="text">We received a request to reset the password for your Njimbong account. Click the button below to choose a new password.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${link}" class="btn">Reset Password</a>
    </p>
    <p class="text">This link expires in <strong>1 hour</strong>. If you did not request a password reset, you can safely ignore this email — your password will not be changed.</p>
    <hr class="divider"/>
    <p class="meta">If the button does not work, copy and paste this link into your browser:<br/>
      <a href="${link}">${link}</a>
    </p>
  `,
  );
  await send({
    to: user.email,
    subject: "Reset your Njimbong password",
    html,
  });
}

export async function sendDisputeConfirmation(user, listing, orderId) {
  const html = wrap(
    "Dispute Submitted — Njimbong",
    `
    <p class="greeting">${user.name}, your dispute has been submitted.</p>
    <p class="text">Our team has been notified and will review your dispute within 24–48 business hours. The funds held in escrow remain frozen until the dispute is resolved.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order Reference</span><span class="info-value">#${orderId}</span></div>
      <div class="info-row"><span class="info-label">Listing</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-red">Under Dispute</span></span></div>
    </div>
    <hr class="divider"/>
    <p class="meta">For urgent matters, contact <a href="mailto:support@njimbong.com">support@njimbong.com</a> with your order reference <strong>#${orderId}</strong>.</p>
  `,
  );
  await send({
    to: user.email,
    subject: `Dispute submitted for order #${orderId} — Njimbong`,
    html,
  });
}
