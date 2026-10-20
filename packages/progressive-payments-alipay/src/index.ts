// Alipay real adapter (PAY-T010 batch 2026-10-02).
// OpenAPI: https://opendocs.alipay.com — RSA2 (SHA256withRSA) request
// signing with the application private key; async notifications (form
// posts) are verified with the Alipay platform public key over the sorted
// `k=v` set (sign and sign_type excluded), per «异步通知» documentation.
import { createSign, createVerify } from "node:crypto";
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

const DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do";

function statusOf(providerStatus: string): NormalizedProviderOutcome {
  if (providerStatus === "TRADE_SUCCESS" || providerStatus === "TRADE_FINISHED") return "SUCCEEDED";
  if (providerStatus === "TRADE_CLOSED") return "FAILED";
  return "PENDING"; // WAIT_BUYER_PAY
}

/** RSA2 signature over the sorted, `+`-joined `k=v` pairs (Alipay §签名). */
function signParams(params: Readonly<Record<string, string>>, privateKeyPem: string): string {
  const base = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const signer = createSign("RSA-SHA256");
  signer.update(base);
  return signer.sign(privateKeyPem, "base64");
}

function verifyParams(
  params: Readonly<Record<string, string>>,
  publicKeyPem: string,
  sign: string,
): boolean {
  const base = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(base);
  return verifier.verify(publicKeyPem, sign, "base64");
}

function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

export class AlipayProvider implements PaymentProvider {
  readonly providerType = "alipay";
  readonly secretRequirements = ["appId", "privateKey"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      alipayPublicKey: {
        type: "string",
        description: "Alipay platform public key (PEM) — verifies async notifications",
      },
      gatewayUrl: { type: "string", description: `default ${DEFAULT_GATEWAY}` },
    },
  };

  private readonly config: { alipayPublicKey?: string; gatewayUrl?: string };

  constructor(config: { alipayPublicKey?: string; gatewayUrl?: string } = {}) {
    this.config = config;
  }

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  private async call(
    secrets: PaymentSecrets,
    method: string,
    bizContent: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      app_id: secrets.values["appId"] ?? "",
      method,
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
    };
    params["sign"] = signParams(params, secrets.values["privateKey"] ?? "");
    const gateway = this.config.gatewayUrl ?? DEFAULT_GATEWAY;
    const response = await fetch(gateway, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const envelope = body[`${method.replace(/\./g, "_")}_response`] as
      | { code?: string; msg?: string; sub_msg?: string }
      | undefined;
    if (response.ok === false || envelope === undefined || (envelope.code ?? "40000") !== "10000") {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `alipay ${method} → ${envelope?.code ?? response.status} ${envelope?.sub_msg ?? envelope?.msg ?? ""}`.trim(),
      );
    }
    return envelope as Record<string, unknown>;
  }

  async createPayment(
    input: ProviderCreateInput,
    secrets: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    const result = await this.call(secrets, "alipay.trade.create", {
      out_trade_no: input.paymentId,
      total_amount: input.amount.toFixed(2),
      subject: input.description ?? `payment ${input.paymentId}`,
      ...(input.callbackUrl === undefined ? {} : { notify_url: input.callbackUrl }),
    });
    const tradeNo = String(result["trade_no"] ?? "");
    return { externalId: tradeNo, status: "PENDING", providerStatus: "WAIT_BUYER_PAY" };
  }

  async getPayment(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    try {
      const result = await this.call(secrets, "alipay.trade.query", { trade_no: externalId });
      const status = String(result["trade_status"] ?? "WAIT_BUYER_PAY");
      return { status: statusOf(status), providerStatus: status };
    } catch {
      return null;
    }
  }

  async cancelPayment(externalId: string, secrets: PaymentSecrets): Promise<void> {
    await this.call(secrets, "alipay.trade.close", { trade_no: externalId });
  }

  async refundPayment(
    externalId: string,
    amount: number,
    _currency: string,
    secrets: PaymentSecrets,
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }> {
    await this.call(secrets, "alipay.trade.refund", {
      trade_no: externalId,
      refund_amount: amount.toFixed(2),
      out_request_no: idempotencyKey ?? `refund-${externalId}-${amount}`,
    });
    return {};
  }

  verifyCallback(request: InboundRequestView): void {
    const publicKey = this.config.alipayPublicKey;
    if (publicKey === undefined || publicKey.length === 0) {
      throw new PaymentError(
        "PAYMENT_INBOUND_INVALID",
        "alipay notifications cannot be verified: provider config lacks alipayPublicKey",
      );
    }
    const params = parseForm(request.rawBody);
    const sign = params["sign"] ?? "";
    if (sign === "") {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "alipay notification has no signature");
    }
    const verified = verifyParams(params, publicKey, sign);
    if (!verified) {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "alipay notification signature mismatch");
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const params = parseForm(request.rawBody);
    const providerStatus = params["trade_status"] ?? "";
    return {
      providerEventId:
        params["notify_id"] ?? `alipay:${params["trade_no"] ?? ""}:${providerStatus}`,
      externalPaymentId: params["trade_no"] ?? null,
      idempotencyKey: params["out_trade_no"] ?? null,
      outcome: statusOf(providerStatus),
      providerStatus,
      ...(params["total_amount"] === undefined
        ? {}
        : { amount: Number.parseFloat(params["total_amount"]) }),
      currency: "CNY",
    };
  }
}


/** Composition factory (ADR-0017 S5): resolved by the trusted catalog's
 * payment_provider registration. Configuration lives in provider instances
 * (payment_provider_instance), so the factory takes no platform input. */
export function createAlipayProvider(): AlipayProvider {
  return new AlipayProvider();
}
