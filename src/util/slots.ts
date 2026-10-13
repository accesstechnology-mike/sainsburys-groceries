import type { DeliverySlot } from "../types.ts";

const TIME_RANGE_RE = /(\d{1,2}(?::\d{2})?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?)/;
const PRICE_RE = /£\s?(\d+(?:\.\d{1,2})?)/;

export function parseSlotTexts(raw: { id: string; text: string }[]): DeliverySlot[] {
  const out: DeliverySlot[] = [];
  for (const item of raw) {
    const range = TIME_RANGE_RE.exec(item.text);
    if (!range) continue;
    const price = PRICE_RE.exec(item.text);
    const dateMatch = /\b(\d{1,2}\s+[A-Za-z]{3,9}|\bMon\b|\bTue\b|\bWed\b|\bThu\b|\bFri\b|\bSat\b|\bSun\b)/.exec(item.text);
    out.push({
      id: item.id,
      start: range[1],
      end: range[2],
      date: dateMatch?.[1]?.trim(),
      price: price?.[1] ? parseFloat(price[1]) : undefined,
      type: /sameday/i.test(item.text) ? "same-day" : /flex/i.test(item.text) ? "flexible" : undefined,
      raw: item.text,
    });
  }
  const seen = new Set<string>();
  return out.filter((slot) => {
    const key = `${slot.date ?? ""}|${slot.start}|${slot.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
