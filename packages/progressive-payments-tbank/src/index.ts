// T-Bank (ex-Tinkoff) real adapter (PAY-T010 batch 2026-10-02).
// EACQ API: https://developer.tbank.ru/eacq — every request carries a
// `Token` = sha256 of the sorted concatenated parameter values with the
// terminal Password appended last; amounts are minor units (kopecks).
// Webhook notifications are verified synchronously with the same algorithm.
import { createHash, timingSafeEqual } from "node:crypto";
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

const DEFAULT_API_BASE = "https://securepay.tbank.ru/v2";

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "CONFIRMED") return "SUCCEEDED";
  if (
    providerStatus === "REJECTED" ||
    providerStatus === "CANCELED" ||
    providerStatus === "DEADLINE_EXPIRED" ||
    providerStatus === "REVERSED"
  )
    return "FAILED";
  return "PENDING"; // NEW / AUTHORIZED / FORMSHOWED
}

/** T-Bank request token: sorted non-empty values + Password, sha256 hex. */
function requestToken(values: Readonly<Record<string, unknown>>, password: string): string {
  const concat = Object.keys(values)
    .filter((key) => key !== "Token" && key !== "Receipt" && key !== "DATA")
    .sort()
    .map((key) => `${String(values[key] ?? "")}`)
    .concat(password)
    .join("");
  return createHash("sha256").update(concat).digest("hex");
}

export class TBankProvider implements PaymentProvider {
  readonly providerType = "tbank";
  readonly secretRequirements = ["terminalKey", "password"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBase: { type: "string", description: "default https://securepay.tbank.ru/v2" },
    },
  };

  private readonly config: { apiBase?: string };

  constructor(config: { apiBase?: string } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  private async call(
    secrets: PaymentSecrets,
    method: "Init" | "GetState" | "Cancel" | "Refund",
    fields: Record<string, unknown>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Record<string, unknown> & { PaymentId?: string | number; Status?: string }> {
    const base = this.config.apiBase ?? DEFAULT_API_BASE;
    const terminalKey = secrets.values["terminalKey"] ?? "";
    const password = secrets.values["password"] ?? "";
    const payload = {
      TerminalKey: terminalKey,
      ...fields,
      Token: requestToken({ ...fields, TerminalKey: terminalKey }, password),
    };
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options?.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": options.idempotencyKey }),
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body["Success"] === false) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `tbank ${method} → HTTP ${response.status}: ${String(body["Message"] ?? body["Details"] ?? "unknown error")}`,
      );
    }
    return body as Record<string, unknown> & { PaymentId?: string; Status?: string };
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const result = await this.call(secrets, "Init", {
      Amount: Math.round(input.amount * 100),
      OrderId: input.paymentId,
      ...(input.description === undefined ? {} : { Description: input.description.slice(0, 140) }),
      ...(input.callbackUrl === undefined ? {} : { NotificationURL: input.callbackUrl }),
      DATA: { pcmsIdempotencyKey: input.idempotencyKey },
    });
    const paymentId = String(result["PaymentId"] ?? "");
    const status = String(result["Status"] ?? "NEW");
    return {
      externalId: paymentId,
      status: statusOf(status),
      ...(typeof status === "string" ? { providerStatus: status } : {}),
    };
  }

  async getPayment(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    try {
      const result = await this.call(secrets, "GetState", { PaymentId: externalId });
      const status = String(result["Status"] ?? "NEW");
      return { status: statusOf(status), providerStatus: status };
    } catch {
      return null;
    }
  }

  async cancelPayment(externalId: string, secrets: PaymentSecrets): Promise<void> {
    await this.call(secrets, "Cancel", { PaymentId: externalId });
  }

  async refundPayment(
    externalId: string,
    amount: number,
    _currency: string,
    secrets: PaymentSecrets,
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }> {
    // S7: the stable per-intent key rides the T-Bank Idempotency-Key header —
    // a timed-out POST is retried against the SAME logical refund, never a
    // second one.
    const result = await this.call(
      secrets,
      "Refund",
      {
        PaymentId: externalId,
        Amount: Math.round(amount * 100),
      },
      idempotencyKey === undefined ? undefined : { idempotencyKey },
    );
    return {
      ...(result["RefundId"] === undefined ? {} : { providerRefundId: String(result["RefundId"]) }),
    };
  }

  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void {
    const body = JSON.parse(request.rawBody) as Record<string, unknown>;
    const expected = String(body["Token"] ?? "");
    const actual = requestToken(body, secrets.values["password"] ?? "");
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "tbank notification token mismatch");
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const body = JSON.parse(request.rawBody) as {
      PaymentId?: string | number;
      OrderId?: string;
      Success?: boolean;
      Status?: string;
      Amount?: number;
      NotificationId?: string | number;
    };
    const providerStatus = body.Status ?? "";
    const outcome: NormalizedProviderOutcome =
      body.Success === true && providerStatus === "CONFIRMED"
        ? "SUCCEEDED"
        : body.Success === false
          ? "FAILED"
          : statusOf(providerStatus);
    return {
      providerEventId:
        body.NotificationId === undefined
          ? `tbank:${String(body.PaymentId ?? "")}:${providerStatus}`
          : String(body.NotificationId),
      externalPaymentId: body.PaymentId === undefined ? null : String(body.PaymentId),
      idempotencyKey: body.OrderId ?? null,
      outcome,
      providerStatus,
      ...(body.Amount === undefined ? {} : { amount: body.Amount / 100 }),
      currency: "RUB",
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createTBankProvider(): TBankProvider {
  return new TBankProvider();
}
