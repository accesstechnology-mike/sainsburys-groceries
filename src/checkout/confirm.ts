import fs from "node:fs";
import path from "node:path";
import { SainsburysError } from "../errors.ts";
import type { Basket, Reservation } from "../types.ts";
import type { CheckoutEndpoint } from "./har.ts";
import { paymentKey } from "./har.ts";
import { canonicalPreview, previewToken, slotIdFrom, type PreviewPayload } from "./preview.ts";

export interface StoredPreview {
  token: string;
  payload: PreviewPayload;
  savedAt: string;
}

export function loadPreview(file: string): StoredPreview | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredPreview;
  } catch {
    return null;
  }
}

export function savePreview(file: string, preview: StoredPreview): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(preview, null, 2), { mode: 0o600 });
}

export function loadCheckoutMap(file: string): CheckoutEndpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { endpoints?: CheckoutEndpoint[] };
    return parsed.endpoints?.find((endpoint) => endpoint.id === "checkout.confirm") ?? null;
  } catch {
    return null;
  }
}

export function assertPreviewMatches(token: string, basket: Basket, reservation: Reservation, stored: StoredPreview | null): PreviewPayload {
  const payload = canonicalPreview(basket, reservation);
  const current = previewToken(payload);
  if (!stored || stored.token !== token) {
    throw new SainsburysError("preview_mismatch", "Run `checkout preview` and pass that token. This token was not issued for the saved preview.");
  }
  if (current !== token) {
    throw new SainsburysError(
      "preview_mismatch",
      "Basket, slot, or total changed since preview. Refusing to confirm. Run preview again.",
    );
  }
  return payload;
}

/** Build a confirm body from the preview. HAR values are not copied. */
export function confirmBody(endpoint: CheckoutEndpoint, basket: Basket, reservation: Reservation, token: string): Record<string, string | number> {
  const forbidden = paymentKey(endpoint.bodyKeys);
  if (forbidden) {
    throw new SainsburysError(
      "payment_challenge",
      `Checkout endpoint asks for ${forbidden}. This client does not send card data.`,
    );
  }
  const values: Record<string, string | number | null> = {
    basket_id: basket.basket_id ?? null,
    order_id: basket.order_id ?? null,
    slot_id: slotIdFrom(reservation),
    preview_token: token,
    token,
  };
  const body: Record<string, string | number> = {};
  for (const key of endpoint.bodyKeys) {
    const value = values[key];
    if (value == null) {
      throw new SainsburysError(
        "site_changed",
        `Checkout confirm needs ${key} from the current basket or slot, and this preview does not have it. Nothing was posted.`,
      );
    }
    body[key] = value;
  }
  return body;
}
