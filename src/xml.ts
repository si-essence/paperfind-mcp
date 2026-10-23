import { XMLParser } from "fast-xml-parser";

const ARRAY_TAGS = new Set([
  "entry",
  "author",
  "link",
  "category",
  "PubmedArticle",
  "Author",
  "AbstractText",
  "ArticleId",
  "citation",
  "reference",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ARRAY_TAGS.has(name),
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseXml(xml: string): unknown {
  return toUnknown(parser.parse(xml));
}

function toUnknown(value: unknown): unknown {
  return value;
}

export function xmlToPlainText(xml: string, cap: number): { text: string; truncated: boolean } {
  const withoutNoise = xml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withBreaks = withoutNoise.replace(/<\/(p|title|sec|abstract|tr|h\d|caption)>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (decoded.length <= cap) return { text: decoded, truncated: false };
  return { text: decoded.slice(0, cap), truncated: true };
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => fromCode(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function fromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
