// YooKassa real adapter (PAY-T010 batch 2026-10-02).
// API: https://yookassa.ru/developers/api — Basic auth (shopId:secretKey),
// `Idempotence-Key` header on mutating calls; amounts as "100.00" strings.
// Notifications carry no cryptographic signature; YooKassa documents fixed
// source IP ranges instead — verification is a CIDR allowlist over the
// forwarded client IP (fail-closed: unlisted IPs are rejected).
import { PaymentError } from "@pcms/payments";
import type {
  InboundRequestView,
  NormalizedProviderOutcome,
  ParsedCallback,
  PaymentProvider,
  PaymentProviderCapabilities,
  PaymentSecrets,
  ProviderCreateInput,
  ProviderCreateResult,
} from "@pcms/payments";

const DEFAULT_API_BASE = "https://api.yookassa.ru/v3";
/** YooKassa documented notification source ranges (developers/api, "Notifications"). */
const DEFAULT_ALLOWED_IPS = ["185.71.76.0/27", "185.71.77.0/27"];

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "succeeded") return "SUCCEEDED";
  if (providerStatus === "canceled") return "FAILED";
  return "PENDING"; // pending / waiting_for_capture
}

interface YooKassaPayment {
  id: string;
  status: string;
  paid?: boolean;
  amount?: { value?: string; currency?: string };
}

function ipv4InSubnet(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw ?? 32);
  const toInt = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      out = (out << 8) | octet;
    }
    return out >>> 0;
  };
  const ipInt = toInt(ip.trim());
  const rangeInt = toInt(range ?? "");
  if (ipInt === null || rangeInt === null || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function clientIpOf(request: InboundRequestView): string | null {
  const forwarded = request.headers["x-forwarded-for"] ?? request.headers["X-Forwarded-For"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? null;
  }
  const real = request.headers["x-real-ip"] ?? request.headers["X-Real-Ip"];
  return typeof real === "string" && real.length > 0 ? real : null;
}

export class YooKassaProvider implements PaymentProvider {
  readonly providerType = "yookassa";
  readonly secretRequirements = ["shopId", "secretKey"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBase: { type: "string", description: "default https://api.yookassa.ru/v3" },
      allowedIps: {
        type: "array",
        items: { type: "string" },
        description: "webhook source CIDR allowlist; defaults to the documented YooKassa ranges",
      },
    },
  };

  private readonly config: { apiBase?: string; allowedIps?: readonly string[] };

  constructor(config: { apiBase?: string; allowedIps?: readonly string[] } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  private auth(secrets: PaymentSecrets): string {
    const shopId = secrets.values["shopId"] ?? "";
    const secretKey = secrets.values["secretKey"] ?? "";
    return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString("base64")}`;
  }

  private async call(
    secrets: PaymentSecrets,
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<YooKassaPayment> {
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: this.auth(secrets),
        "content-type": "application/json",
        ...(init.idempotencyKey === undefined ? {} : { "idempotence-key": init.idempotencyKey }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `yookassa ${init.method} ${path} → HTTP ${response.status}`,
      );
    }
    return (await response.json()) as YooKassaPayment;
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const payment = await this.call(secrets, "/payments", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        amount: { value: input.amount.toFixed(2), currency: input.currency },
        capture: true,
        ...(input.description === undefined ? {} : { description: input.description }),
        metadata: { pcms_payment_id: input.paymentId },
        confirmation: {
          type: "redirect",
          ...(input.callbackUrl === undefined ? {} : { return_url: input.callbackUrl }),
        },
      },
    });
    return {
      externalId: payment.id,
      status: statusOf(payment.status),
      ...(typeof payment.status === "string" ? { providerStatus: payment.status } : {}),
    };
  }

  async getPayment(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    try {
      const payment = await this.call(secrets, `/payments/${encodeURIComponent(externalId)}`, {
        method: "GET",
      });
      return { status: statusOf(payment.status), providerStatus: payment.status };
    } catch {
      return null;
    }
  }

  async cancelPayment(externalId: string, secrets: PaymentSecrets): Promise<void> {
    await this.call(secrets, `/payments/${encodeURIComponent(externalId)}/cancel`, {
      method: "POST",
    });
  }

  async refundPayment(
    externalId: string,
    amount: number,
    currency: string,
    secrets: PaymentSecrets,
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }> {
    const refund = await this.call(secrets, `/payments/${encodeURIComponent(externalId)}/refunds`, {
      method: "POST",
      idempotencyKey: idempotencyKey ?? `refund-${externalId}-${amount}`,
      body: { amount: { value: amount.toFixed(2), currency } },
    });
    return { providerRefundId: refund.id };
  }

  verifyCallback(request: InboundRequestView): void {
    const ip = clientIpOf(request);
    const allowed = this.config.allowedIps ?? DEFAULT_ALLOWED_IPS;
    if (ip === null || !allowed.some((cidr) => ipv4InSubnet(ip, cidr))) {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        `yookassa notification from unlisted source IP: ${ip ?? "unknown"}`,
      );
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const body = JSON.parse(request.rawBody) as {
      event?: string;
      object?: YooKassaPayment & { metadata?: Record<string, string> };
    };
    const object = body.object ?? { id: "", status: "" };
    const outcome = statusOf(object.status ?? "");
    return {
      providerEventId: `${body.event ?? "payment"}:${object.id}`,
      externalPaymentId: object.id ?? null,
      idempotencyKey:
        typeof object.metadata?.pcms_payment_id === "string"
          ? object.metadata.pcms_payment_id
          : null,
      outcome,
      providerStatus: object.status,
      ...(object.amount?.value === undefined
        ? {}
        : { amount: Number.parseFloat(object.amount.value) }),
      ...(object.amount?.currency === undefined ? {} : { currency: object.amount.currency }),
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createYooKassaProvider(): YooKassaProvider {
  return new YooKassaProvider();
}
