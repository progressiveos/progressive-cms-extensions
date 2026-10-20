// PayPal real adapter (PAY-T010 batch 2026-10-02).
// REST API: https://developer.paypal.com/api/rest — OAuth2 client
// credentials → Orders v2. Webhook trust is verified through PayPal's own
// /v1/notifications/verify-webhook-signature endpoint (documented offline
// certificate validation is deliberately not re-implemented here).
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

const DEFAULT_API_BASE = "https://api-m.paypal.com";

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "COMPLETED") return "SUCCEEDED";
  if (providerStatus === "VOIDED" || providerStatus === "DECLINED") return "FAILED";
  return "PENDING"; // CREATED / APPROVED / PAYER_ACTION_REQUIRED / SAVED
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class PayPalProvider implements PaymentProvider {
  readonly providerType = "paypal";
  readonly secretRequirements = ["clientId", "clientSecret", "webhookId"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBase: {
        type: "string",
        description: "default https://api-m.paypal.com; sandbox: https://api-m.sandbox.paypal.com",
      },
    },
  };

  private readonly config: { apiBase?: string };
  private cachedToken: CachedToken | null = null;

  constructor(config: { apiBase?: string } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  private async oauthToken(secrets: PaymentSecrets): Promise<string> {
    if (this.cachedToken !== null && Date.now() < this.cachedToken.expiresAtMs - 60_000) {
      return this.cachedToken.token;
    }
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const auth = Buffer.from(
      `${secrets.values["clientId"] ?? ""}:${secrets.values["clientSecret"] ?? ""}`,
    ).toString("base64");
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!response.ok) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", `paypal oauth → HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (body.access_token === undefined) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "paypal oauth returned no token");
    }
    this.cachedToken = {
      token: body.access_token,
      expiresAtMs: Date.now() + (body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  private async call(
    secrets: PaymentSecrets,
    path: string,
    init: { method: string; body?: unknown; requestId?: string },
  ): Promise<Record<string, unknown>> {
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const token = await this.oauthToken(secrets);
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.requestId === undefined ? {} : { "paypal-request-id": init.requestId }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const body = (text.length === 0 ? {} : JSON.parse(text)) as Record<string, unknown>;
    if (!response.ok) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `paypal ${init.method} ${path} → HTTP ${response.status}`,
      );
    }
    return body;
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const order = await this.call(secrets, "/v2/checkout/orders", {
      method: "POST",
      requestId: input.idempotencyKey,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.paymentId,
            custom_id: input.idempotencyKey,
            ...(input.description === undefined
              ? {}
              : { description: input.description.slice(0, 127) }),
            amount: { currency_code: input.currency, value: input.amount.toFixed(2) },
          },
        ],
      },
    });
    const id = String(order["id"] ?? "");
    const status = String(order["status"] ?? "CREATED");
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
      const order = await this.call(
        secrets,
        `/v2/checkout/orders/${encodeURIComponent(externalId)}`,
        {
          method: "GET",
        },
      );
      const status = String(order["status"] ?? "CREATED");
      return { status: statusOf(status), providerStatus: status };
    } catch {
      return null;
    }
  }

  async cancelPayment(externalId: string, secrets: PaymentSecrets): Promise<void> {
    await this.call(secrets, `/v2/checkout/orders/${encodeURIComponent(externalId)}/cancel`, {
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
    // Refunds target the CAPTURE, which the order exposes once completed.
    const order = await this.call(
      secrets,
      `/v2/checkout/orders/${encodeURIComponent(externalId)}`,
      {
        method: "GET",
      },
    );
    const units =
      (order["purchase_units"] as
        | { payments?: { captures?: { id?: string }[] }[] }[]
        | undefined) ?? [];
    const captureId = units[0]?.payments?.[0]?.captures?.[0]?.id;
    if (captureId === undefined) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        "paypal refund: the order has no capture yet",
      );
    }
    const refund = await this.call(
      secrets,
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: "POST",
        requestId: idempotencyKey ?? `refund-${externalId}-${amount}`,
        body: { amount: { currency_code: currency, value: amount.toFixed(2) } },
      },
    );
    return { ...(refund["id"] === undefined ? {} : { providerRefundId: String(refund["id"]) }) };
  }

  /** PayPal-trusted verification: their own endpoint validates the
   * transmission against the configured webhook id — no local shortcuts. */
  async verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): Promise<void> {
    const header = (name: string): string =>
      String(request.headers[name] ?? request.headers[name.toUpperCase()] ?? "");
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const token = await this.oauthToken(secrets);
    const response = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: header("paypal-auth-algo"),
        cert_url: header("paypal-cert-url"),
        transmission_id: header("paypal-transmission-id"),
        transmission_sig: header("paypal-transmission-sig"),
        transmission_time: header("paypal-transmission-time"),
        webhook_id: secrets.values["webhookId"] ?? "",
        webhook_event: JSON.parse(request.rawBody),
      }),
    });
    if (!response.ok) {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        `paypal webhook verification → HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { verification_status?: string };
    if (body.verification_status !== "SUCCESS") {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        `paypal webhook verification: ${body.verification_status ?? "unknown"}`,
      );
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const body = JSON.parse(request.rawBody) as {
      id?: string;
      event_type?: string;
      resource?: {
        id?: string;
        status?: string;
        custom_id?: string;
        supplementary_data?: { related_ids?: { order_id?: string } };
        amount?: { value?: string; currency_code?: string };
      };
    };
    const resource = body.resource ?? {};
    const type = body.event_type ?? "";
    const outcome: NormalizedProviderOutcome = type.endsWith("COMPLETED")
      ? "SUCCEEDED"
      : type.endsWith("DECLINED") || type.endsWith("VOIDED") || type.endsWith("DENIED")
        ? "FAILED"
        : "PENDING";
    const custom = typeof resource.custom_id === "string" ? resource.custom_id : null;
    return {
      providerEventId: body.id ?? null,
      externalPaymentId: resource.supplementary_data?.related_ids?.order_id ?? resource.id ?? null,
      idempotencyKey: custom === null ? null : custom.replace(/^pcms:/, ""),
      outcome,
      ...(resource.status === undefined ? {} : { providerStatus: resource.status }),
      ...(resource.amount?.value === undefined
        ? {}
        : { amount: Number.parseFloat(resource.amount.value) }),
      ...(resource.amount?.currency_code === undefined
        ? {}
        : { currency: resource.amount.currency_code }),
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createPayPalProvider(): PayPalProvider {
  return new PayPalProvider();
}
