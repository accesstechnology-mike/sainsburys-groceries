import crypto from "node:crypto";
import type { Basket, Reservation } from "../types.ts";

export interface PreviewPayload {
  basket_id: string | number | null;
  order_id: string | number | null;
  items: { item_uid: string; quantity: number; subtotal_price: number | null; sku: string | null }[];
  slot: unknown;
  subtotal_price: number | null;
  total_price: number | null;
  minimum_spend: number | null;
}

export function canonicalPreview(basket: Basket, reservation: Reservation): PreviewPayload {
  const items = (basket.items ?? [])
    .map((item) => ({
      item_uid: String(item.item_uid),
      quantity: Number(item.quantity),
      subtotal_price: item.subtotal_price ?? null,
      sku: item.product?.sku ? String(item.product.sku) : null,
    }))
    .sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  return {
    basket_id: basket.basket_id ?? null,
    order_id: basket.order_id ?? null,
    items,
    slot: reservation.slot ?? null,
    subtotal_price: basket.subtotal_price ?? null,
    total_price: basket.total_price ?? null,
    minimum_spend: basket.minimum_spend ?? null,
  };
}

export function previewToken(payload: PreviewPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function slotIdFrom(reservation: Reservation): string | null {
  const slot = reservation.slot as { slot_id?: unknown; id?: unknown; slot_info?: { slot_id?: unknown } } | undefined;
  const value = slot?.slot_id ?? slot?.id ?? slot?.slot_info?.slot_id;
  return value == null || value === "" ? null : String(value);
}
