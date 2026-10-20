// Tabby real adapter (PAY-T010 batch 2026-10-02) — the leading UAE BNPL.
// Merchant API: https://docs.tabby.ai — checkout sessions created with
// `Authorization: Bearer <secret key>`; async payment status updates are
// webhook-signed per merchant configuration. Trust is fail-closed: without
// a configured signing secret notifications are rejected (status sync via
// getPayment stays available).
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

const DEFAULT_API_BASE = "https://api.tabby.ai";

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "captured" || providerStatus === "authorized") return "SUCCEEDED";
  if (providerStatus === "rejected" || providerStatus === "expired") return "FAILED";
  return "PENDING"; // created / in_progress
}

export class TabbyProvider implements PaymentProvider {
  readonly providerType = "tabby";
  readonly secretRequirements = ["merchantCode", "secretKey", "webhookSecret"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBase: { type: "string", description: "default https://api.tabby.ai" },
      signatureHeader: {
        type: "string",
        description: "webhook signature header name, default x-tabby-signature",
      },
    },
  };

  private readonly config: { apiBase?: string; signatureHeader?: string };

  constructor(config: { apiBase?: string; signatureHeader?: string } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    // Tabby has no merchant-side cancel of an authorized BNPL plan.
    return { cancel: false, refund: true, providerIdempotency: false, statusSync: true };
  }

  private async call(
    secrets: PaymentSecrets,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secrets.values["secretKey"] ?? ""}`,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `tabby ${init.method} ${path} → HTTP ${response.status}`,
      );
    }
    return body;
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const session = await this.call(secrets, "/api/v2/checkout", {
      method: "POST",
      body: {
        merchant_code: secrets.values["merchantCode"] ?? "",
        payment: {
          amount: input.amount.toFixed(2),
          currency: input.currency,
          description: input.description ?? `payment ${input.paymentId}`,
          order_reference: input.paymentId,
          ...(input.callbackUrl === undefined ? {} : { redirect_url: input.callbackUrl }),
        },
      },
    });
    const payment = (session["payment"] ?? {}) as { id?: string; status?: string };
    return {
      externalId: String(payment.id ?? ""),
      status: statusOf(String(payment.status ?? "created")),
      providerStatus: String(payment.status ?? "created"),
    };
  }

  async getPayment(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    try {
      const payment = await this.call(
        secrets,
        `/api/v2/payments/${encodeURIComponent(externalId)}`,
        {
          method: "GET",
        },
      );
      const status = String(payment["status"] ?? "created");
      return { status: statusOf(status), providerStatus: status };
    } catch {
      return null;
    }
  }

  /**
   * S7: Tabby's refund API has NO idempotency mechanism — a retried POST
   * after an unknown outcome could double-refund. The platform therefore
   * never auto-retries a Tabby refund whose outcome is unknown: the intent
   * lands in NEEDS_REVIEW for manual reconciliation. The key parameter is
   * accepted (contract uniformity) and ignored.
   */
  async refundPayment(
    externalId: string,
    amount: number,
    currency: string,
    secrets: PaymentSecrets,
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }> {
    void idempotencyKey;
    const refund = await this.call(
      secrets,
      `/api/v2/payments/${encodeURIComponent(externalId)}/refunds`,
      {
        method: "POST",
        body: { amount: amount.toFixed(2), currency },
      },
    );
    return { ...(refund["id"] === undefined ? {} : { providerRefundId: String(refund["id"]) }) };
  }

  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void {
    const headerName = this.config.signatureHeader ?? "x-tabby-signature";
    const provided = request.headers[headerName] ?? request.headers[headerName.toUpperCase()] ?? "";
    const expected = createHmac("sha256", secrets.values["webhookSecret"] ?? "")
      .update(request.rawBody)
      .digest("hex");
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        `tabby notification signature missing or invalid (header ${headerName})`,
      );
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const body = JSON.parse(request.rawBody) as {
      payment?: { id?: string; status?: string; order_reference?: string; amount?: string };
    };
    const payment = body.payment ?? {};
    const providerStatus = payment.status ?? "created";
    return {
      providerEventId: `tabby:${payment.id ?? ""}:${providerStatus}`,
      externalPaymentId: payment.id ?? null,
      idempotencyKey: payment.order_reference ?? null,
      outcome: statusOf(providerStatus),
      providerStatus,
      ...(payment.amount === undefined ? {} : { amount: Number.parseFloat(payment.amount) }),
      currency: "AED",
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createTabbyProvider(): TabbyProvider {
  return new TabbyProvider();
}
