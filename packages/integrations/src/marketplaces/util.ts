import type { ProductOffer, ProductQuery } from "./types";

/** Фильтр по цене, сортировка и лимит поверх выдачи площадки (выдача может игнорировать фильтры). */
export function filterAndSort(
  offers: ProductOffer[],
  query: ProductQuery,
): ProductOffer[] {
  let result = offers.filter(
    (o) =>
      (query.priceMin === undefined || o.price >= query.priceMin) &&
      (query.priceMax === undefined || o.price <= query.priceMax),
  );
  if (query.sort === "price_asc")
    result = result.sort((a, b) => a.price - b.price);
  if (query.sort === "price_desc")
    result = result.sort((a, b) => b.price - a.price);
  if (query.sort === "rating")
    result = result.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return result.slice(0, query.limit ?? 10);
}

/** «12 990 ₽», "4.8", 562 → число; мусор → undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\s\u00a0\u2009\u202f]/g, "")
    .replace(/₽|руб\.?/gi, "")
    .replace(",", ".");
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|#39|nbsp);/gi,
    (_, e: string) => {
      const lower = e.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return (
        { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00a0" }[
          lower
        ] ?? _
      );
    },
  );
}

/** Текст без тегов и лишних пробелов. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}
