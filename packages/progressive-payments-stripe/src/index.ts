// Stripe real adapter (PAY-T010 batch 2026-10-02).
// API: https://docs.stripe.com/api — PaymentIntents over form-encoded POSTs
// with Bearer secret key; `Stripe-Idempotency-Key` header for safe retries.
// Webhooks: `Stripe-Signature: t=…,v1=…` — HMAC-SHA256 of `${t}.${body}`
// with the endpoint's signing secret, replay window checked on `t`.
import { createHmac, timingSafeEqual } from "node:crypto";
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

const DEFAULT_API_BASE = "https://api.stripe.com/v1";

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "succeeded") return "SUCCEEDED";
  if (providerStatus === "canceled") return "FAILED";
  return "PENDING"; // requires_payment_method / requires_confirmation / requires_action / processing
}

export class StripeProvider implements PaymentProvider {
  readonly providerType = "stripe";
  readonly secretRequirements = ["secretKey", "webhookSecret"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBase: { type: "string", description: "default https://api.stripe.com/v1" },
      webhookToleranceSeconds: {
        type: "integer",
        description: "replay window for the Stripe-Signature timestamp, default 300",
      },
    },
  };

  private readonly config: { apiBase?: string; webhookToleranceSeconds?: number };

  constructor(config: { apiBase?: string; webhookToleranceSeconds?: number } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  private async call(
    secrets: PaymentSecrets,
    path: string,
    init: { method: string; form?: Record<string, string>; idempotencyKey?: string },
  ): Promise<Record<string, unknown> & { id?: string; status?: string }> {
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secrets.values["secretKey"] ?? ""}`,
        ...(init.form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(init.idempotencyKey === undefined
          ? {}
          : { "stripe-idempotency-key": init.idempotencyKey }),
      },
      ...(init.form === undefined ? {} : { body: new URLSearchParams(init.form) }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `stripe ${init.method} ${path} → HTTP ${response.status}: ${body.error?.message ?? "unknown error"}`,
      );
    }
    return body;
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const result = await this.call(secrets, "/payment_intents", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      form: {
        amount: String(Math.round(input.amount * 100)),
        currency: input.currency.toLowerCase(),
        "metadata[pcms_payment_id]": input.paymentId,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
    const id = String(result["id"] ?? "");
    const status = String(result["status"] ?? "requires_payment_method");
    return {
      externalId: id,
      status: statusOf(status),
      ...(typeof status === "string" ? { providerStatus: status } : {}),
    };
  }

  async getPayment(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    try {
      const result = await this.call(
        secrets,
        `/payment_intents/${encodeURIComponent(externalId)}`,
        {
          method: "GET",
        },
      );
      const status = String(result["status"] ?? "processing");
      return { status: statusOf(status), providerStatus: status };
    } catch {
      return null;
    }
  }

  async cancelPayment(externalId: string, secrets: PaymentSecrets): Promise<void> {
    await this.call(secrets, `/payment_intents/${encodeURIComponent(externalId)}/cancel`, {
      method: "POST",
    });
  }

  async refundPayment(
    externalId: string,
    amount: number,
    _currency: string,
    secrets: PaymentSecrets,
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }> {
    const result = await this.call(secrets, "/refunds", {
      method: "POST",
      idempotencyKey: idempotencyKey ?? `refund-${externalId}-${amount}`,
      form: { payment_intent: externalId, amount: String(Math.round(amount * 100)) },
    });
    return { ...(result["id"] === undefined ? {} : { providerRefundId: String(result["id"]) }) };
  }

  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void {
    const header = request.headers["stripe-signature"] ?? request.headers["Stripe-Signature"] ?? "";
    const parts = new Map<string, string>(
      String(header)
        .split(",")
        .map((piece) => piece.split("=", 2) as [string, string]),
    );
    const timestamp = parts.get("t");
    const signatures = [...parts.entries()].filter(([key]) => key === "v1").map(([, v]) => v);
    if (timestamp === undefined || signatures.length === 0) {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        "stripe signature header is missing fields",
      );
    }
    const tolerance = (this.config.webhookToleranceSeconds ?? 300) * 1000;
    if (Math.abs(Date.now() - Number(timestamp) * 1000) > tolerance) {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "stripe signature timestamp is stale");
    }
    const expected = createHmac("sha256", secrets.values["webhookSecret"] ?? "")
      .update(`${timestamp}.${request.rawBody}`)
      .digest("hex");
    const expectedBuffer = Buffer.from(expected);
    const matched = signatures.some((candidate) => {
      const candidateBuffer = Buffer.from(candidate);
      return (
        candidateBuffer.length === expectedBuffer.length &&
        timingSafeEqual(candidateBuffer, expectedBuffer)
      );
    });
    if (!matched) {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "stripe signature mismatch");
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const body = JSON.parse(request.rawBody) as {
      id?: string;
      type?: string;
      data?: { object?: { id?: string; status?: string; metadata?: Record<string, string> } };
    };
    const object = body.data?.object ?? {};
    const type = body.type ?? "";
    const outcome: NormalizedProviderOutcome = type.endsWith("succeeded")
      ? "SUCCEEDED"
      : type.endsWith("failed") || type.endsWith("canceled")
        ? "FAILED"
        : "PENDING";
    return {
      providerEventId: body.id ?? null,
      externalPaymentId: object.id ?? null,
      idempotencyKey:
        typeof object.metadata?.pcms_payment_id === "string"
          ? object.metadata.pcms_payment_id
          : null,
      outcome,
      ...(object.status === undefined ? {} : { providerStatus: object.status }),
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createStripeProvider(): StripeProvider {
  return new StripeProvider();
}
