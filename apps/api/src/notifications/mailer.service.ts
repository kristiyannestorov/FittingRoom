import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { formatMoney, type Currency } from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly webUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    const user = config.get('SMTP_USER', { infer: true });
    this.transporter = createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user ? { user, pass: config.get('SMTP_PASSWORD', { infer: true }) } : undefined,
    });
    this.from = config.get('MAIL_FROM', { infer: true });
    this.webUrl = config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
  }

  async deliver(outboundEmailId: string): Promise<void> {
    const email = await this.prisma.outboundEmail.findUnique({ where: { id: outboundEmailId } });
    if (!email) return;
    if (email.sentAt) {
      this.logger.debug(`Email ${outboundEmailId} already sent`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: email.toEmail,
        subject: email.subject,
        html: this.render(email.template, email.payload as Record<string, unknown>),
      });

      await this.prisma.outboundEmail.update({
        where: { id: outboundEmailId },
        data: { sentAt: new Date(), attempts: { increment: 1 }, error: null },
      });
      this.logger.log(`Sent ${email.template} to ${email.toEmail}`);
    } catch (error) {
      await this.prisma.outboundEmail.update({
        where: { id: outboundEmailId },
        data: {
          failedAt: new Date(),
          attempts: { increment: 1 },
          error: (error as Error).message.slice(0, 500),
        },
      });
      throw error;
    }
  }

  private render(template: string, payload: Record<string, unknown>): string {
    const orderNumber = String(payload.orderNumber ?? '');
    const name = String(payload.fullName ?? 'there');
    const currency = (payload.currency as Currency) ?? 'EUR';

    switch (template) {
      case 'order-confirmed':
        return layout(
          `Thank you, ${escapeHtml(name)}`,
          `
            <p>We have received your payment for order <strong>${escapeHtml(orderNumber)}</strong>.</p>
            ${renderItems(payload, currency)}
            ${renderTotals(payload, currency)}
            <p>We will email you again as soon as it ships.</p>
            ${button(`${this.webUrl}/orders`, 'View your order')}
          `,
        );

      case 'payment-failed':
        return layout(
          'Payment could not be completed',
          `
            <p>Hello ${escapeHtml(name)},</p>
            <p>We were unable to process payment for order <strong>${escapeHtml(orderNumber)}</strong>,
            so it has not been placed. Nothing has been charged.</p>
            ${button(`${this.webUrl}/cart`, 'Try again')}
          `,
        );

      case 'order-in-production':
        return layout(
          'Your order is being made',
          `
            <p>Hello ${escapeHtml(name)},</p>
            <p>Order <strong>${escapeHtml(orderNumber)}</strong> is made to order and has entered
            production. We will let you know the moment it ships.</p>
          `,
        );

      case 'order-shipped': {
        const tracking = payload.trackingNumber ? String(payload.trackingNumber) : null;
        return layout(
          'Your order is on its way',
          `
            <p>Hello ${escapeHtml(name)},</p>
            <p>Order <strong>${escapeHtml(orderNumber)}</strong> has been handed to
            ${escapeHtml(String(payload.trackingProvider ?? 'the courier'))}.</p>
            ${tracking ? `<p>Tracking number: <strong>${escapeHtml(tracking)}</strong></p>` : ''}
            ${tracking ? button(`${this.webUrl}/track/${encodeURIComponent(tracking)}`, 'Track your parcel') : ''}
          `,
        );
      }

      case 'order-delivered':
        return layout(
          'Delivered',
          `
            <p>Hello ${escapeHtml(name)},</p>
            <p>Order <strong>${escapeHtml(orderNumber)}</strong> has been delivered. We hope you
            love it.</p>
          `,
        );

      case 'order-cancelled':
        return layout(
          'Order cancelled',
          `
            <p>Hello ${escapeHtml(name)},</p>
            <p>Order <strong>${escapeHtml(orderNumber)}</strong> has been cancelled and any
            reserved items released.</p>
          `,
        );

      case 'low-stock-alert':
        return layout(
          'Low stock',
          `
            <p>SKU <strong>${escapeHtml(String(payload.sku ?? ''))}</strong> is down to
            ${escapeHtml(String(payload.quantityAvailable ?? 0))} units, at or below its reorder
            threshold of ${escapeHtml(String(payload.threshold ?? 0))}.</p>
            ${button(`${this.webUrl}/admin/inventory`, 'Open inventory')}
          `,
        );

      default:
        return layout('Update', `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter.close();
  }
}

const INK = '#161616';
const PAPER = '#faf9f7';
const ACCENT = '#8a5a44';
const BORDER = '#ece8e3';
const MUTED = '#7a7570';

interface EmailItem {
  name: string;
  variant: string | null;
  size: string;
  quantity: number;
  unitPriceMinor: number;
  thumbnailUrl?: string | null;
}

function renderItems(payload: Record<string, unknown>, currency: Currency): string {
  const items = (payload.items as EmailItem[] | undefined) ?? [];
  if (items.length === 0) return '';

  const rows = items
    .map(
      (item) => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid ${BORDER};width:64px">
            ${
              item.thumbnailUrl
                ? `<img src="${escapeHtml(item.thumbnailUrl)}" width="56" height="56" alt=""
                     style="display:block;width:56px;height:56px;border-radius:8px;object-fit:cover;background:${BORDER}">`
                : `<div style="width:56px;height:56px;border-radius:8px;background:${BORDER}"></div>`
            }
          </td>
          <td style="padding:14px 0 14px 14px;border-bottom:1px solid ${BORDER}">
            <div style="font-weight:600;color:${INK}">${escapeHtml(item.name)}${item.variant ? ` &middot; ${escapeHtml(item.variant)}` : ''}</div>
            <div style="color:${MUTED};font-size:13px;margin-top:2px">Size ${escapeHtml(item.size)} &times; ${item.quantity}</div>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;font-weight:600;color:${INK}">
            ${escapeHtml(formatMoney({ amountMinor: item.unitPriceMinor * item.quantity, currency }))}
          </td>
        </tr>`,
    )
    .join('');

  return `<table style="width:100%;border-collapse:collapse;margin:20px 0">${rows}</table>`;
}

function renderTotals(payload: Record<string, unknown>, currency: Currency): string {
  const line = (label: string, minor: unknown): string =>
    typeof minor === 'number'
      ? `<tr><td style="padding:3px 0;color:${MUTED}">${label}</td><td style="text-align:right;color:${INK}">${escapeHtml(
          formatMoney({ amountMinor: minor, currency }),
        )}</td></tr>`
      : '';

  return `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${line('Subtotal', payload.subtotalMinor)}
      ${line('Shipping', payload.shippingMinor)}
      <tr><td style="padding-top:10px;font-weight:700;color:${INK}">Total</td>
      <td style="padding-top:10px;text-align:right;font-weight:700;color:${INK}">${
        typeof payload.totalMinor === 'number'
          ? escapeHtml(formatMoney({ amountMinor: payload.totalMinor, currency }))
          : ''
      }</td></tr>
    </table>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:28px 0 4px">
    <a href="${escapeHtml(href)}"
       style="background:${ACCENT};color:${PAPER};padding:13px 22px;border-radius:8px;text-decoration:none;
              display:inline-block;font-weight:600;font-size:14px">
      ${escapeHtml(label)}
    </a>
  </p>`;
}

function layout(heading: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#f1efec;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK}">
  <div style="max-width:560px;margin:0 auto">
    <div style="text-align:center;margin-bottom:20px">
      <span style="font-size:18px;font-weight:700;letter-spacing:0.02em;color:${INK}">ProjectZed</span>
    </div>
    <div style="background:${PAPER};padding:36px;border-radius:16px;border:1px solid ${BORDER}">
      <h1 style="font-size:21px;margin:0 0 16px;color:${INK}">${escapeHtml(heading)}</h1>
      <div style="font-size:15px;line-height:1.6;color:${INK}">${body}</div>
    </div>
    <p style="text-align:center;color:${MUTED};font-size:12px;margin:20px 0 0">ProjectZed &middot; Plovdiv, Bulgaria</p>
  </div>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
